#!/usr/bin/env python3
"""Short-lived stdlib IMAP/SMTP bridge for the FRIDAY Channels plugin.

A single JSON request is read from stdin and a single JSON response is written
on stdout. Credential values are never accepted on argv or environment.
"""
from __future__ import annotations

import email
import imaplib
import json
import re
import smtplib
import ssl
import sys
from email.message import EmailMessage
from email.policy import default
from email.utils import parseaddr
from typing import Any


def cleanup_warning(operation: str, error: Exception) -> None:
    """Write content-free cleanup telemetry without corrupting stdout protocol."""
    sys.stderr.write(json.dumps({
        "type": "friday.email-bridge.cleanup-failure",
        "operation": operation,
        "errorType": type(error).__name__,
    }, separators=(",", ":")) + "\n")


def emit(value: Any) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()


def fail(message: str) -> None:
    emit({"ok": False, "error": message})
    raise SystemExit(1)


def clean_header(value: Any, limit: int = 4096) -> str:
    return str(value or "").replace("\x00", "").strip()[:limit]


def message_text(message: email.message.EmailMessage) -> str:
    if message.is_multipart():
        plain: list[str] = []
        html: list[str] = []
        for part in message.walk():
            if part.get_content_disposition() == "attachment":
                continue
            kind = part.get_content_type()
            if kind not in {"text/plain", "text/html"}:
                continue
            try:
                content = part.get_content()
            except Exception:
                payload = part.get_payload(decode=True) or b""
                content = payload.decode(part.get_content_charset() or "utf-8", "replace")
            if kind == "text/plain":
                plain.append(str(content))
            else:
                html.append(str(content))
        if plain:
            return "\n".join(plain).strip()
        source = "\n".join(html)
    else:
        try:
            source = str(message.get_content())
        except Exception:
            payload = message.get_payload(decode=True) or b""
            source = payload.decode(message.get_content_charset() or "utf-8", "replace")
        if message.get_content_type() != "text/html":
            return source.strip()
    source = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", source)
    source = re.sub(r"(?s)<[^>]+>", " ", source)
    source = re.sub(r"[ \t]+", " ", source)
    source = re.sub(r"\n\s*\n\s*\n+", "\n\n", source)
    return source.strip()


def connect_imap(request: dict[str, Any]):
    host = clean_header(request.get("imapHost"), 512)
    port = int(request.get("imapPort") or 993)
    use_tls = bool(request.get("imapTls", True))
    if not host:
        fail("imap host is required")
    if use_tls:
        client = imaplib.IMAP4_SSL(host, port, ssl_context=ssl.create_default_context())
    else:
        client = imaplib.IMAP4(host, port)
    client.login(clean_header(request.get("address"), 512), str(request.get("password") or ""))
    mailbox = clean_header(request.get("mailbox") or "INBOX", 256)
    status, _ = client.select(mailbox, readonly=True)
    if status != "OK":
        client.logout()
        fail("imap mailbox select failed")
    return client


def imap_status(request: dict[str, Any]) -> None:
    client = connect_imap(request)
    try:
        mailbox = clean_header(request.get("mailbox") or "INBOX", 256)
        status, values = client.status(mailbox, "(UIDNEXT)")
        if status != "OK" or not values:
            fail("imap status failed")
        raw = values[0].decode("utf-8", "replace") if isinstance(values[0], bytes) else str(values[0])
        match = re.search(r"UIDNEXT\s+(\d+)", raw, re.I)
        max_uid = max(0, int(match.group(1)) - 1) if match else 0
        emit({"ok": True, "maxUid": max_uid})
    finally:
        try:
            client.logout()
        except Exception as error:
            cleanup_warning("imap logout after status", error)


def imap_poll(request: dict[str, Any]) -> None:
    client = connect_imap(request)
    try:
        after_uid = max(0, int(request.get("afterUid") or 0))
        maximum = min(20, max(1, int(request.get("maxMessages") or 8)))
        max_message_bytes = min(20 * 1024 * 1024, max(64 * 1024, int(request.get("maxMessageBytes") or 5 * 1024 * 1024)))
        status, data = client.uid("search", None, f"UID {after_uid + 1}:*")
        if status != "OK":
            fail("imap search failed")
        ids = [int(value) for value in (data[0] or b"").split() if value.isdigit()]
        ids = [uid for uid in ids if uid > after_uid][:maximum]
        messages: list[dict[str, Any]] = []
        max_uid = after_uid
        for uid in ids:
            # Bound untrusted mailbox input before downloading/parsing it. Large
            # messages are advanced past rather than retried forever.
            size_status, size_data = client.uid("fetch", str(uid), "(RFC822.SIZE)")
            size_text = " ".join(
                item.decode("utf-8", "replace") if isinstance(item, bytes) else str(item)
                for item in (size_data or [])
                if item is not None
            )
            size_match = re.search(r"RFC822\.SIZE\s+(\d+)", size_text, re.I)
            if size_status != "OK" or not size_match:
                continue
            if int(size_match.group(1)) > max_message_bytes:
                max_uid = max(max_uid, uid)
                continue
            status, fetched = client.uid("fetch", str(uid), "(BODY.PEEK[])")
            if status != "OK" or not fetched:
                continue
            raw = b""
            for item in fetched:
                if isinstance(item, tuple) and len(item) >= 2 and isinstance(item[1], (bytes, bytearray)):
                    raw += bytes(item[1])
            if not raw:
                continue
            parsed = email.message_from_bytes(raw, policy=default)
            sender_name, sender_address = parseaddr(str(parsed.get("From") or ""))
            message_id = clean_header(parsed.get("Message-ID"), 512) or f"imap-uid-{uid}"
            references = clean_header(parsed.get("References"), 4096).split()
            in_reply_to = clean_header(parsed.get("In-Reply-To"), 512)
            thread_id = references[0] if references else (in_reply_to or message_id)
            attachments: list[dict[str, Any]] = []
            for part in parsed.walk():
                if len(attachments) >= 20:
                    break
                filename = part.get_filename()
                if not filename:
                    continue
                payload = part.get_payload(decode=True) or b""
                attachments.append({
                    "externalId": f"{message_id}:{len(attachments)}",
                    "fileName": clean_header(filename, 512),
                    "mimeType": clean_header(part.get_content_type(), 128),
                    "sizeBytes": len(payload),
                })
            messages.append({
                "uid": uid,
                "messageId": message_id,
                "threadId": thread_id,
                "inReplyTo": in_reply_to or None,
                "fromAddress": sender_address.lower().strip(),
                "fromName": clean_header(sender_name, 512) or None,
                "subject": clean_header(parsed.get("Subject"), 1024),
                "date": clean_header(parsed.get("Date"), 256),
                "text": message_text(parsed)[:65536],
                "attachments": attachments,
            })
            max_uid = max(max_uid, uid)
        emit({"ok": True, "maxUid": max_uid, "messages": messages})
    finally:
        try:
            client.logout()
        except Exception as error:
            cleanup_warning("imap logout after poll", error)


def smtp_send(request: dict[str, Any]) -> None:
    host = clean_header(request.get("smtpHost"), 512)
    port = int(request.get("smtpPort") or 587)
    mode = clean_header(request.get("smtpTls") or "starttls", 32).lower()
    address = clean_header(request.get("address"), 512)
    password = str(request.get("password") or "")
    recipient = clean_header(request.get("to"), 512)
    if not host or not address or not recipient:
        fail("smtp host, address and recipient are required")
    message = EmailMessage()
    message["From"] = address
    message["To"] = recipient
    message["Subject"] = clean_header(request.get("subject") or "FRIDAY", 998)
    in_reply_to = clean_header(request.get("inReplyTo"), 512)
    if in_reply_to:
        message["In-Reply-To"] = in_reply_to
        message["References"] = in_reply_to
    message.set_content(str(request.get("text") or ""))
    context = ssl.create_default_context()
    if mode == "ssl":
        client = smtplib.SMTP_SSL(host, port, timeout=30, context=context)
    else:
        client = smtplib.SMTP(host, port, timeout=30)
        client.ehlo()
        if mode == "starttls":
            client.starttls(context=context)
            client.ehlo()
    try:
        client.login(address, password)
        response = client.send_message(message)
        if response:
            fail("smtp recipient rejected")
        emit({"ok": True, "messageId": clean_header(message.get("Message-ID"), 512) or "smtp-sent"})
    finally:
        try:
            client.quit()
        except Exception as error:
            cleanup_warning("smtp quit", error)


def main() -> None:
    try:
        request = json.loads(sys.stdin.read())
        if not isinstance(request, dict):
            fail("request must be an object")
        command = request.get("command")
        if command == "status":
            imap_status(request)
        elif command == "poll":
            imap_poll(request)
        elif command == "send":
            smtp_send(request)
        else:
            fail("unknown command")
    except SystemExit:
        raise
    except Exception:
        fail("email bridge operation failed")


if __name__ == "__main__":
    main()
