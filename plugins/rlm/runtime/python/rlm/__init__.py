"""Tiny model-facing recursive delegation shim for a FRIDAY IPython kernel."""

from __future__ import annotations

import asyncio
import sys
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from ipykernel.comm import Comm
except Exception:  # pragma: no cover - depends on the kernel environment
    Comm = None  # type: ignore[assignment]

try:
    from IPython import get_ipython
except Exception:  # pragma: no cover - only available in kernels
    get_ipython = None  # type: ignore[assignment]

HOST_COMM_TARGET = "host.request"


@dataclass(frozen=True)
class RLMSpawnHandle:
    rlm_child_id: str
    name: str
    session_dir: Path
    model: str


@dataclass(frozen=True)
class RLMModel:
    provider: str
    id: str
    name: str
    selector: str


@dataclass(frozen=True)
class RLMSubagent:
    rlm_child_id: str
    active_session_id: str | None
    session_id: str | None
    session_name: str
    session_dir: Path
    status: str


def _install_control_comm_handlers() -> None:
    """Let comm replies arrive on the control channel during an execute_request."""
    if get_ipython is None:
        return
    shell = get_ipython()
    kernel = getattr(shell, "kernel", None)
    comm_manager = getattr(kernel, "comm_manager", None)
    control_handlers = getattr(kernel, "control_handlers", None)
    if comm_manager is None or not isinstance(control_handlers, dict):
        return
    control_handlers.setdefault("comm_msg", comm_manager.comm_msg)
    control_handlers.setdefault("comm_close", comm_manager.comm_close)


def _spawn_handle_from_payload(payload: Any) -> RLMSpawnHandle:
    if not isinstance(payload, dict):
        raise RuntimeError("rlm.run returned an invalid spawn handle")
    child_id = payload.get("rlm_child_id")
    name = payload.get("name")
    session_dir = payload.get("session_dir")
    model = payload.get("model")
    if not all(isinstance(value, str) and value for value in (child_id, name, session_dir, model)):
        raise RuntimeError("rlm.run returned an invalid spawn handle")
    return RLMSpawnHandle(
        rlm_child_id=child_id,
        name=name,
        session_dir=Path(session_dir),
        model=model,
    )


async def host_request(request_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Send one typed request to the host and await its comm reply."""
    if not isinstance(request_type, str) or not request_type:
        raise TypeError("request_type must be a non-empty str")
    if payload is not None and not isinstance(payload, dict):
        raise TypeError(f"payload must be a dict or None, got {type(payload).__name__}")
    if Comm is None:
        raise RuntimeError("Jupyter comm support is unavailable in this kernel")
    _install_control_comm_handlers()

    loop = asyncio.get_running_loop()
    future: asyncio.Future[dict[str, Any]] = loop.create_future()
    comm = Comm(target_name=HOST_COMM_TARGET, primary=False)

    def _on_msg(msg: dict[str, Any]) -> None:
        content = msg.get("content", {})
        reply = content.get("data", {}) if isinstance(content, dict) else {}
        if not isinstance(reply, dict):
            return

        status = reply.get("status")
        if status == "ok":
            def _resolve_result() -> None:
                if not future.done():
                    future.set_result({k: v for k, v in reply.items() if k != "status"})
                    comm.close()

            loop.call_soon_threadsafe(_resolve_result)
            return
        if status == "error":
            message = reply.get("error") or f"host request {request_type} failed"

            def _resolve_error() -> None:
                if not future.done():
                    future.set_exception(RuntimeError(str(message)))
                    comm.close()

            loop.call_soon_threadsafe(_resolve_error)
            return

        unexpected = f"host request {request_type} returned unexpected status: {status!r}"

        def _resolve_unexpected() -> None:
            if not future.done():
                future.set_exception(RuntimeError(unexpected))
                comm.close()

        loop.call_soon_threadsafe(_resolve_unexpected)

    comm.on_msg(_on_msg)
    comm.open(data={**(payload or {}), "type": request_type})
    return await future


async def run(prompt: str, **kwargs: Any) -> RLMSpawnHandle:
    """Spawn a child and return once the task is admitted."""
    if not isinstance(prompt, str):
        raise TypeError(f"prompt must be str, got {type(prompt).__name__}")
    payload = await host_request("rlm.run", {"prompt": prompt, "kwargs": kwargs})
    return _spawn_handle_from_payload(payload)


async def spawn_many(tasks: list[dict[str, Any] | str]) -> list[RLMSpawnHandle]:
    """Admit a bounded fan-out batch without serializing child execution."""
    if not isinstance(tasks, list) or not tasks or len(tasks) > 32:
        raise ValueError("tasks must be a list containing between 1 and 32 entries")
    normalized: list[dict[str, Any]] = []
    for index, task in enumerate(tasks):
        if isinstance(task, str):
            if not task.strip():
                raise ValueError(f"tasks[{index}] must not be empty")
            normalized.append({"prompt": task})
            continue
        if not isinstance(task, dict) or not isinstance(task.get("prompt"), str) or not task["prompt"].strip():
            raise TypeError(f"tasks[{index}] must be a prompt string or dict with prompt")
        unsupported = set(task) - {"prompt", "name", "model"}
        if unsupported:
            raise ValueError(f"tasks[{index}] contains unsupported keys: {', '.join(sorted(unsupported))}")
        normalized.append(dict(task))
    payload = await host_request("rlm.spawn_many", {"tasks": normalized})
    handles = payload.get("subagents")
    if not isinstance(handles, list):
        raise RuntimeError("rlm.spawn_many returned an invalid subagents list")
    return [_spawn_handle_from_payload(handle) for handle in handles]


def _model_from_payload(payload: Any) -> RLMModel:
    if not isinstance(payload, dict):
        raise RuntimeError("rlm.find_models returned an invalid model entry")
    provider = payload.get("provider")
    model_id = payload.get("id")
    name = payload.get("name")
    selector = payload.get("selector")
    if not all(isinstance(value, str) and value for value in (provider, model_id, name, selector)):
        raise RuntimeError("rlm.find_models returned an invalid model entry")
    return RLMModel(provider=provider, id=model_id, name=name, selector=selector)


async def find_models(query: str = "", limit: int = 8) -> list[RLMModel]:
    """Search a bounded model list supplied by the host."""
    if not isinstance(query, str):
        raise TypeError(f"query must be str, got {type(query).__name__}")
    if not isinstance(limit, int):
        raise TypeError(f"limit must be int, got {type(limit).__name__}")
    payload = await host_request("rlm.find_models", {"query": query, "limit": limit})
    models = payload.get("models")
    if not isinstance(models, list):
        raise RuntimeError("rlm.find_models returned an invalid models list")
    return [_model_from_payload(model) for model in models]


def _subagent_from_payload(payload: Any, operation: str = "rlm.list_subagents") -> RLMSubagent:
    if not isinstance(payload, dict):
        raise RuntimeError(f"{operation} returned an invalid subagent entry")
    child_id = payload.get("rlm_child_id")
    active_session_id = payload.get("active_session_id")
    session_id = payload.get("session_id")
    session_name = payload.get("session_name")
    session_dir = payload.get("session_dir")
    status = payload.get("status")
    if not isinstance(child_id, str) or not child_id:
        raise RuntimeError(f"{operation} entry is missing rlm_child_id")
    if active_session_id is not None and not isinstance(active_session_id, str):
        raise RuntimeError(f"{operation} entry has invalid active_session_id")
    if session_id is not None and not isinstance(session_id, str):
        raise RuntimeError(f"{operation} entry has invalid session_id")
    if not isinstance(session_name, str) or not session_name:
        raise RuntimeError(f"{operation} entry is missing session_name")
    if not isinstance(session_dir, str) or not session_dir:
        raise RuntimeError(f"{operation} entry is missing session_dir")
    if status not in {"running", "completed", "error"}:
        raise RuntimeError(f"{operation} entry has invalid status")
    return RLMSubagent(
        rlm_child_id=child_id,
        active_session_id=active_session_id,
        session_id=session_id,
        session_name=session_name,
        session_dir=Path(session_dir),
        status=status,
    )


async def list_subagents() -> list[RLMSubagent]:
    """List direct children retained by the current parent session."""
    payload = await host_request("rlm.list_subagents")
    entries = payload.get("subagents")
    if not isinstance(entries, list):
        raise RuntimeError("rlm.list_subagents returned an invalid subagents registry")
    return [_subagent_from_payload(entry) for entry in entries]


async def wait_subagents(targets: list[str | RLMSpawnHandle | RLMSubagent], timeout: float = 1800.0) -> list[RLMSubagent]:
    """Wait for a fan-out set to reach terminal state, then return stable registry views."""
    if not isinstance(targets, list) or not targets or len(targets) > 32:
        raise ValueError("targets must contain between 1 and 32 entries")
    if not isinstance(timeout, (int, float)) or timeout <= 0 or timeout > 86400:
        raise ValueError("timeout must be greater than 0 and at most 86400 seconds")
    selectors: list[str] = []
    for index, target in enumerate(targets):
        if isinstance(target, (RLMSpawnHandle, RLMSubagent)):
            selectors.append(target.rlm_child_id)
        elif isinstance(target, str) and target.strip():
            selectors.append(target.strip())
        else:
            raise TypeError(f"targets[{index}] must be str, RLMSpawnHandle, or RLMSubagent")
    payload = await host_request("rlm.wait_subagents", {"targets": selectors, "timeoutMs": int(timeout * 1000)})
    entries = payload.get("subagents")
    if not isinstance(entries, list):
        raise RuntimeError("rlm.wait_subagents returned an invalid subagents registry")
    return [_subagent_from_payload(entry, "rlm.wait_subagents") for entry in entries]


async def gather(tasks: list[dict[str, Any] | str], timeout: float = 1800.0) -> list[RLMSubagent]:
    """Fan out independent child tasks concurrently and fan in on terminal status."""
    handles = await spawn_many(tasks)
    return await wait_subagents(handles, timeout=timeout)


async def delete_subagent(target: str | RLMSubagent) -> RLMSubagent:
    """Delete one running or retained direct child from the current parent session."""
    if isinstance(target, RLMSubagent):
        selector = target.rlm_child_id
    elif isinstance(target, str):
        selector = target.strip()
        if not selector:
            raise ValueError("target must not be empty")
    else:
        raise TypeError(f"target must be str or RLMSubagent, got {type(target).__name__}")
    payload = await host_request("rlm.delete_subagent", {"target": selector})
    return _subagent_from_payload(payload.get("subagent"), "rlm.delete_subagent")


class _RLMCallable:
    async def run(self, prompt: str, **kwargs: Any) -> RLMSpawnHandle:
        return await run(prompt, **kwargs)

    async def spawn_many(self, tasks: list[dict[str, Any] | str]) -> list[RLMSpawnHandle]:
        return await spawn_many(tasks)

    async def wait_subagents(self, targets: list[str | RLMSpawnHandle | RLMSubagent], timeout: float = 1800.0) -> list[RLMSubagent]:
        return await wait_subagents(targets, timeout)

    async def gather(self, tasks: list[dict[str, Any] | str], timeout: float = 1800.0) -> list[RLMSubagent]:
        return await gather(tasks, timeout)

    async def find_models(self, query: str = "", limit: int = 8) -> list[RLMModel]:
        return await find_models(query, limit)

    async def list_subagents(self) -> list[RLMSubagent]:
        return await list_subagents()

    async def delete_subagent(self, target: str | RLMSubagent) -> RLMSubagent:
        return await delete_subagent(target)

    async def __call__(self, prompt: str, **kwargs: Any) -> RLMSpawnHandle:
        return await run(prompt, **kwargs)


rlm = _RLMCallable()


class _CallableModule(types.ModuleType):
    async def __call__(self, prompt: str, **kwargs: Any) -> RLMSpawnHandle:
        return await run(prompt, **kwargs)


sys.modules[__name__].__class__ = _CallableModule

__all__ = [
    "RLMModel",
    "RLMSpawnHandle",
    "RLMSubagent",
    "delete_subagent",
    "gather",
    "find_models",
    "host_request",
    "list_subagents",
    "rlm",
    "run",
    "spawn_many",
    "wait_subagents",
]
