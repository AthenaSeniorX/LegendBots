from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np
from PIL import Image, ImageDraw

import VarOlanHesaplardanHesapOlusturucu_Brov as bot


class AccountCreatorVisualEvidenceTests(unittest.TestCase):
    def test_other_bot_and_terminal_processes_are_protected_from_cleanup(self) -> None:
        for process_name in (
            "chrome.exe",
            "node.exe",
            "powershell.exe",
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        ):
            self.assertTrue(bot._is_protected_automation_process_name(process_name))
        self.assertFalse(bot._is_protected_automation_process_name("Legend Online.exe"))

    def test_hemen_dene_reference_is_detected(self) -> None:
        image = Image.open(bot.CLIENT_GAME_READY_IMAGE).convert("RGB")
        match, score = bot._detect_game_ready_screen(image, confidence=0.72)
        self.assertIsNotNone(match)
        self.assertGreater(score, 0.99)

    def test_hemen_dene_is_detected_on_scaled_game_window(self) -> None:
        source = Image.open(bot.CLIENT_GAME_READY_IMAGE).convert("RGB")
        scaled = source.resize(
            (round(source.width * 1.25), round(source.height * 1.25)),
            Image.Resampling.LANCZOS,
        )
        canvas = Image.new("RGB", (1280, 720), (8, 15, 24))
        canvas.paste(scaled, (430, 260))
        match, score = bot._detect_game_ready_screen(canvas, confidence=0.72)
        self.assertIsNotNone(match)
        self.assertGreater(score, 0.9)

    def test_unrelated_screen_is_not_accepted(self) -> None:
        noise = np.random.default_rng(42).integers(0, 256, (720, 1280, 3), dtype=np.uint8)
        image = Image.fromarray(cv2.cvtColor(noise, cv2.COLOR_BGR2RGB))
        match, _ = bot._detect_game_ready_screen(image, confidence=0.72)
        self.assertIsNone(match)

    def test_two_blue_bars_remain_the_primary_evidence(self) -> None:
        image = Image.new("RGB", (1000, 800), (10, 18, 30))
        drawing = ImageDraw.Draw(image)
        drawing.rectangle((200, 610, 760, 630), fill=(0, 160, 255))
        drawing.rectangle((200, 665, 760, 685), fill=(0, 160, 255))
        self.assertIsNotNone(bot._detect_two_blue_loading_bars(image))

    def test_progress_records_the_actual_visual_evidence(self) -> None:
        with tempfile.TemporaryDirectory(prefix="legendbots-progress-") as temporary:
            path = Path(temporary) / "completed_accounts.json"
            store = bot.ProgressStore(path, {})
            store.mark_completed("test22@example.com", "NICK22", "game_ready_screen")
            payload = json.loads(path.read_text(encoding="utf-8"))
            verification = payload["completed_accounts"]["test22@example.com"]["verification"]
            self.assertEqual(verification["method"], "game_ready_screen")
            self.assertTrue(verification["game_ready_screen"])
            self.assertFalse(verification["two_blue_loading_bars"])

    def test_completed_account_can_be_reverified_without_losing_nickname(self) -> None:
        with tempfile.TemporaryDirectory(prefix="legendbots-reverify-") as temporary:
            path = Path(temporary) / "completed_accounts.json"
            store = bot.ProgressStore(path, {})
            store.mark_completed("test41@example.com", "NICK41", "two_blue_loading_bars")

            self.assertTrue(store.mark_for_reverification("test41@example.com", "role missing"))

            payload = json.loads(path.read_text(encoding="utf-8"))
            self.assertNotIn("test41@example.com", payload["completed_accounts"])
            pending = payload["pending_verification"]["test41@example.com"]
            self.assertEqual(pending["nickname"], "NICK41")
            self.assertEqual(pending["reverification_reason"], "role missing")

    def test_client_keeps_verified_session_open_for_server_role_persistence(self) -> None:
        self.assertGreaterEqual(bot.ClientConfig().post_verification_wait, 10.0)

    def test_blue_bars_win_when_both_success_screens_are_visible(self) -> None:
        blue = bot.GameEntryEvidence("two_blue_loading_bars", 101, ((1, 2, 3, 4), (1, 8, 3, 4)))
        game_ready = bot.GameEntryEvidence("game_ready_screen", 102, (10, 20, 30, 40, 0.99))
        frame = Image.new("RGB", (800, 600), (0, 0, 0))
        with (
            patch.object(bot.pyautogui, "screenshot", return_value=frame),
            patch.object(
                bot,
                "_scan_game_entry_frame",
                return_value=(blue, game_ready, 0.99, []),
            ),
            patch.object(bot.time, "sleep", return_value=None),
        ):
            result = bot._wait_for_game_entry_success(
                object(),
                timeout=2,
                game_ready_confidence=0.72,
            )
        self.assertEqual(result.method, "two_blue_loading_bars")

    def test_hemen_dene_is_used_when_blue_bars_were_missed(self) -> None:
        game_ready = bot.GameEntryEvidence("game_ready_screen", 102, (10, 20, 30, 40, 0.99))
        frame = Image.new("RGB", (800, 600), (0, 0, 0))
        with (
            patch.object(bot.pyautogui, "screenshot", return_value=frame),
            patch.object(
                bot,
                "_scan_game_entry_frame",
                return_value=(None, game_ready, 0.99, []),
            ),
            patch.object(bot.time, "sleep", return_value=None),
        ):
            result = bot._wait_for_game_entry_success(
                object(),
                timeout=2,
                game_ready_confidence=0.72,
            )
        self.assertEqual(result.method, "game_ready_screen")

    def test_other_screen_times_out_and_requests_retry(self) -> None:
        frame = Image.new("RGB", (800, 600), (0, 0, 0))
        with (
            patch.object(bot.pyautogui, "screenshot", return_value=frame),
            patch.object(
                bot,
                "_scan_game_entry_frame",
                return_value=(None, None, 0.1, []),
            ),
            patch.object(bot.time, "sleep", return_value=None),
            patch.object(bot.time, "monotonic", side_effect=[0.0, 0.0, 2.0]),
        ):
            with self.assertRaisesRegex(bot.AutomationError, "yeniden denenecek"):
                bot._wait_for_game_entry_success(
                    object(),
                    timeout=1,
                    game_ready_confidence=0.72,
                )


if __name__ == "__main__":
    unittest.main()
