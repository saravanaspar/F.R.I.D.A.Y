#!/usr/bin/env python3
"""Bounded AT-SPI bridge for FRIDAY's shared Linux browser window.

The helper never reads password/OTP/token values. It exposes only bounded
accessibility metadata for the FRIDAY-owned window selected by title and
performs actions only against an observation path supplied by the host.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any

try:
    import pyatspi
except Exception as exc:  # pragma: no cover - exercised by host preflight
    raise SystemExit(f"pyatspi unavailable: {exc}")

PROTECTED = re.compile(r"password|passwd|passcode|otp|one[-_ ]?time|verification|captcha|token|secret|pin", re.I)
CHALLENGE = re.compile(r"captcha|verification challenge|are you human|robot check", re.I)
INTERACTIVE_ROLES = {
    "push button", "button", "link", "text", "password text", "entry", "combo box",
    "check box", "radio button", "menu item", "page tab", "slider", "spin button",
    "list item", "table cell", "toggle button", "switch",
}


def clean(value: Any, maximum: int = 512) -> str:
    text = str(value or "").replace("\x00", " ")
    text = re.sub(r"[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", text)
    return re.sub(r"\s+", " ", text).strip()[:maximum]


def role_name(obj: Any) -> str:
    try:
        return clean(obj.getRoleName(), 128).lower() or "element"
    except Exception:
        return "element"


def state_has(state: Any, constant: Any) -> bool:
    try:
        return bool(state.contains(constant))
    except Exception:
        return False


def attributes(obj: Any) -> dict[str, str]:
    try:
        raw = obj.getAttributes() or []
    except Exception:
        raw = []
    result: dict[str, str] = {}
    for entry in raw:
        key, sep, value = str(entry).partition(":")
        if sep and key:
            result[clean(key, 128).lower()] = clean(value, 512)
    return result


def text_value(obj: Any, protected: bool) -> str:
    if protected:
        return ""
    try:
        text = obj.queryText()
        count = min(max(int(text.characterCount), 0), 2048)
        if count:
            return clean(text.getText(0, count), 2048)
    except Exception:
        return ""
    return ""


def bounds(obj: Any) -> dict[str, int] | None:
    try:
        extents = obj.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
        x, y, width, height = int(extents.x), int(extents.y), int(extents.width), int(extents.height)
        if width <= 0 or height <= 0:
            return None
        return {"left": x, "top": y, "right": x + width, "bottom": y + height}
    except Exception:
        return None


def child_at(obj: Any, index: int) -> Any:
    try:
        return obj[index]
    except Exception as exc:
        raise RuntimeError(f"accessibility path is stale at child {index}") from exc


def find_frame(title: str, active_only: bool = False) -> Any:
    desktop = pyatspi.Registry.getDesktop(0)
    exact = []
    fuzzy = []
    active_exact = []
    active_fuzzy = []
    needle = clean(title, 1024)
    for app_index in range(desktop.childCount):
        app = child_at(desktop, app_index)
        for frame_index in range(app.childCount):
            frame = child_at(app, frame_index)
            role = role_name(frame)
            if role not in {"frame", "window", "dialog"}:
                continue
            name = clean(getattr(frame, "name", ""), 1024)
            is_active = False
            try:
                state = frame.getState()
                is_active = state_has(state, pyatspi.STATE_ACTIVE)
            except Exception:
                is_active = False
            if name == needle:
                exact.append(frame)
                if is_active:
                    active_exact.append(frame)
            elif needle and (needle in name or name in needle):
                fuzzy.append(frame)
                if is_active:
                    active_fuzzy.append(frame)
    if active_only and active_exact:
        return active_exact[0]
    if active_only and active_fuzzy:
        return active_fuzzy[0]
    if active_only:
        raise RuntimeError("FRIDAY browser accessibility window is not active; retry after the owned browser window receives focus")
    if exact:
        return exact[0]
    if fuzzy:
        return fuzzy[0]
    raise RuntimeError("FRIDAY browser accessibility window is unavailable; enable desktop accessibility and retry")


def resolve_path(frame: Any, path: str) -> Any:
    node = frame
    if not path:
        return node
    for piece in path.split("/"):
        if not piece.isdigit():
            raise RuntimeError("invalid accessibility path")
        node = child_at(node, int(piece))
    return node


def object_signature(obj: Any) -> tuple[str, str, dict[str, str], bool, bool]:
    role = role_name(obj)
    name = clean(getattr(obj, "name", ""), 1024)
    attrs = attributes(obj)
    signature = " ".join([role, name, *[f"{key}={value}" for key, value in attrs.items()]])
    protected = role == "password text" or bool(PROTECTED.search(signature))
    challenge = bool(CHALLENGE.search(signature))
    return role, name, attrs, protected, challenge


def action_names(obj: Any) -> list[str]:
    names: list[str] = []
    try:
        action = obj.queryAction()
        for index in range(min(int(action.nActions), 16)):
            name = clean(action.getName(index), 64).lower()
            if name:
                names.append(name)
    except Exception:
        return names
    return names


def snapshot(args: argparse.Namespace) -> dict[str, Any]:
    frame = find_frame(args.title, args.active)
    query = clean(args.query or "", 512).lower()
    scope = args.scope
    maximum = min(max(int(args.max_elements), 1), 200)
    elements: list[dict[str, Any]] = []
    visited = 0
    address_candidates: list[str] = []

    start = resolve_path(frame, args.near or "") if args.near else frame
    prefix = args.near or ""

    def visit(obj: Any, path: str, depth: int) -> None:
        nonlocal visited
        if len(elements) >= maximum or visited >= 3000 or depth > 18:
            return
        visited += 1
        role, name, attrs, protected, challenge = object_signature(obj)
        state = obj.getState() if hasattr(obj, "getState") else None
        box = bounds(obj)
        value = text_value(obj, protected)
        actions_native = action_names(obj)
        editable = state_has(state, pyatspi.STATE_EDITABLE) if state is not None else False
        interactive = role in INTERACTIVE_ROLES or bool(actions_native) or editable
        visible = state_has(state, pyatspi.STATE_VISIBLE) and state_has(state, pyatspi.STATE_SHOWING) if state is not None else box is not None
        enabled = state_has(state, pyatspi.STATE_ENABLED) if state is not None else True
        focusable = state_has(state, pyatspi.STATE_FOCUSABLE) if state is not None else False
        candidate_text = clean(" ".join([name, value, " ".join(attrs.values())]), 2048).lower()
        include = box is not None and visible and (scope == "all" or interactive)
        if query and query not in candidate_text:
            include = False

        semantic_actions: list[str] = []
        lowered_actions = " ".join(actions_native)
        if any(token in lowered_actions for token in ("click", "press", "activate", "jump", "open")) or role in {"link", "push button", "button", "menu item", "page tab", "check box", "radio button", "toggle button", "switch"}:
            semantic_actions.append("click")
        if editable or role in {"text", "entry", "password text", "combo box", "spin button"}:
            semantic_actions.append("type")
        if role in {"check box", "radio button", "toggle button", "switch"}:
            semantic_actions.append("toggle")
        if role in {"combo box", "list item", "menu item", "page tab"}:
            semantic_actions.append("select")
        if role in {"combo box", "tree item"}:
            semantic_actions.append("expand")
        if role in {"document web", "document frame", "scroll pane", "list", "table"}:
            semantic_actions.append("scroll")

        if include:
            record: dict[str, Any] = {
                "path": path,
                "role": role,
                "name": "[PROTECTED INPUT]" if protected else name,
                "value": "" if protected else value,
                "context": "" if protected else clean(attrs.get("description", "") or attrs.get("placeholder-text", ""), 1024),
                **box,
                "visible": visible,
                "enabled": enabled,
                "focused": state_has(state, pyatspi.STATE_FOCUSED) if state is not None else False,
                "interactive": interactive,
                "clickable": "click" in semantic_actions,
                "editable": "type" in semantic_actions,
                "selectable": "select" in semantic_actions,
                "scrollable": "scroll" in semantic_actions,
                "draggable": False,
                "selected": state_has(state, pyatspi.STATE_SELECTED) if state is not None else False,
                "checked": state_has(state, pyatspi.STATE_CHECKED) if state is not None else False,
                "expanded": state_has(state, pyatspi.STATE_EXPANDED) if state is not None else False,
                "protected": protected,
                "challenge": challenge,
                "actions": [] if protected or challenge else semantic_actions,
                "focusable": focusable,
            }
            elements.append(record)
        if not protected:
            signature = f"{role} {name} {' '.join(attrs.values())}".lower()
            if ("address" in signature or "location" in signature or "url" in signature) and value.startswith(("http://", "https://")):
                address_candidates.append(value)

        try:
            count = min(int(obj.childCount), 512)
        except Exception:
            count = 0
        for index in range(count):
            child_path = f"{path}/{index}" if path else str(index)
            try:
                visit(child_at(obj, index), child_path, depth + 1)
            except Exception:
                continue
            if len(elements) >= maximum or visited >= 3000:
                break

    visit(start, prefix, 0)
    return {
        "frameTitle": clean(getattr(frame, "name", ""), 1024),
        "url": address_candidates[0] if address_candidates else None,
        "elements": elements,
    }


def activate(args: argparse.Namespace) -> dict[str, Any]:
    frame = find_frame(args.title, args.active)
    obj = resolve_path(frame, args.path)
    role, name, attrs, protected, challenge = object_signature(obj)
    if protected or challenge:
        raise RuntimeError("protected browser target requires human takeover")
    if args.kind == "type":
        text = args.text or ""
        try:
            editable = obj.queryEditableText()
            editable.setTextContents(text)
            return {"performed": True, "role": role, "name": name}
        except Exception as exc:
            raise RuntimeError("browser accessibility target is not editable") from exc
    if args.kind == "focus":
        try:
            if not obj.queryComponent().grabFocus():
                raise RuntimeError("browser accessibility target refused focus")
            return {"performed": True, "role": role, "name": name}
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError("browser accessibility target cannot be focused") from exc

    try:
        action = obj.queryAction()
        preferred = ("click", "press", "activate", "jump", "open")
        names = [clean(action.getName(index), 64).lower() for index in range(min(int(action.nActions), 16))]
        index = next((names.index(token) for token in preferred if token in names), 0 if names else -1)
        if index < 0:
            raise RuntimeError("browser accessibility target has no action")
        if not action.doAction(index):
            raise RuntimeError("browser accessibility action was refused")
        return {"performed": True, "role": role, "name": name}
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError("browser accessibility action failed") from exc


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    sub = root.add_subparsers(dest="command", required=True)
    snap = sub.add_parser("snapshot")
    snap.add_argument("--title", required=True)
    snap.add_argument("--scope", choices=("interactive", "all"), default="interactive")
    snap.add_argument("--query", default="")
    snap.add_argument("--near", default="")
    snap.add_argument("--max-elements", type=int, default=80)
    snap.add_argument("--active", action="store_true")
    act = sub.add_parser("action")
    act.add_argument("--title", required=True)
    act.add_argument("--path", required=True)
    act.add_argument("--kind", choices=("click", "type", "focus"), required=True)
    act.add_argument("--text", default="")
    act.add_argument("--active", action="store_true")
    return root


def main() -> None:
    args = parser().parse_args()
    try:
        result = snapshot(args) if args.command == "snapshot" else activate(args)
        sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    except Exception as exc:
        sys.stderr.write(clean(exc, 1024) + "\n")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
