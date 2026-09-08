from __future__ import annotations

import asyncio
import importlib
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

rlm_module = importlib.import_module("rlm")


class RlmShimTest(unittest.TestCase):
    def test_forwards_name_and_model_and_returns_spawn_handle(self) -> None:
        host_request = AsyncMock(
            return_value={
                "rlm_child_id": "sub-a1b2c3d4",
                "name": "api-reviewer",
                "session_dir": "/tmp/parent/sub-a1b2c3d4",
                "model": "test/child",
            }
        )
        with patch.object(rlm_module, "host_request", host_request):
            result = asyncio.run(rlm_module.rlm("check API", name="api-reviewer", model="test/child"))
        self.assertEqual(result.rlm_child_id, "sub-a1b2c3d4")
        self.assertEqual(result.session_dir, Path("/tmp/parent/sub-a1b2c3d4"))
        host_request.assert_awaited_once_with(
            "rlm.run",
            {"prompt": "check API", "kwargs": {"name": "api-reviewer", "model": "test/child"}},
        )

    def test_gather_fans_out_then_waits_for_terminal_children(self) -> None:
        host_request = AsyncMock(
            side_effect=[
                {
                    "subagents": [
                        {"rlm_child_id": "sub-a", "name": "a", "session_dir": "/tmp/a", "model": "test/child"},
                        {"rlm_child_id": "sub-b", "name": "b", "session_dir": "/tmp/b", "model": "test/child"},
                    ]
                },
                {
                    "subagents": [
                        {"rlm_child_id": "sub-a", "active_session_id": None, "session_id": "sa", "session_name": "a", "session_dir": "/tmp/a", "status": "completed"},
                        {"rlm_child_id": "sub-b", "active_session_id": None, "session_id": "sb", "session_name": "b", "session_dir": "/tmp/b", "status": "completed"},
                    ]
                },
            ]
        )
        with patch.object(rlm_module, "host_request", host_request):
            children = asyncio.run(rlm_module.rlm.gather(["one", {"prompt": "two", "name": "b"}], timeout=5))
        self.assertEqual([child.status for child in children], ["completed", "completed"])
        self.assertEqual(host_request.await_args_list[0].args[0], "rlm.spawn_many")
        self.assertEqual(host_request.await_args_list[1].args[0], "rlm.wait_subagents")

    def test_finds_models(self) -> None:
        host_request = AsyncMock(
            return_value={
                "models": [
                    {"provider": "test", "id": "child", "name": "Child", "selector": "test/child"}
                ]
            }
        )
        with patch.object(rlm_module, "host_request", host_request):
            models = asyncio.run(rlm_module.rlm.find_models("child", limit=3))
        self.assertEqual(models[0].selector, "test/child")
        host_request.assert_awaited_once_with("rlm.find_models", {"query": "child", "limit": 3})

    def test_lists_subagents(self) -> None:
        host_request = AsyncMock(
            return_value={
                "subagents": [
                    {
                        "rlm_child_id": "sub-a",
                        "active_session_id": None,
                        "session_id": "session-a",
                        "session_name": "worker-a",
                        "session_dir": "/tmp/sub-a",
                        "status": "completed",
                    }
                ]
            }
        )
        with patch.object(rlm_module, "host_request", host_request):
            children = asyncio.run(rlm_module.list_subagents())
        self.assertEqual(children[0].session_name, "worker-a")
        self.assertEqual(children[0].status, "completed")

    def test_deletes_by_object_child_id(self) -> None:
        child = rlm_module.RLMSubagent(
            rlm_child_id="sub-a",
            active_session_id=None,
            session_id="session-a",
            session_name="worker-a",
            session_dir=Path("/tmp/sub-a"),
            status="running",
        )
        host_request = AsyncMock(
            return_value={
                "subagent": {
                    "rlm_child_id": "sub-a",
                    "active_session_id": None,
                    "session_id": "session-a",
                    "session_name": "worker-a",
                    "session_dir": "/tmp/sub-a",
                    "status": "running",
                }
            }
        )
        with patch.object(rlm_module, "host_request", host_request):
            asyncio.run(rlm_module.delete_subagent(child))
        host_request.assert_awaited_once_with("rlm.delete_subagent", {"target": "sub-a"})

    def test_rejects_invalid_inputs(self) -> None:
        with self.assertRaisesRegex(TypeError, "prompt must be str"):
            asyncio.run(rlm_module.run(123))
        with self.assertRaisesRegex(TypeError, "query must be str"):
            asyncio.run(rlm_module.find_models(123))
        with self.assertRaisesRegex(ValueError, "target must not be empty"):
            asyncio.run(rlm_module.delete_subagent("   "))


if __name__ == "__main__":
    unittest.main()
