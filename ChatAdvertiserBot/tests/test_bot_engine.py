import ctypes
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


BOT_DIR = Path(__file__).resolve().parents[1]
if str(BOT_DIR) not in sys.path:
    sys.path.insert(0, str(BOT_DIR))

import bot_engine  # noqa: E402


class TargetSelectionTests(unittest.TestCase):
    def test_own_gui_process_is_never_selected_as_game(self):
        own_gui = bot_engine.WindowCandidate(
            hwnd=10,
            title="Legend Online - Arka Plan Chat Reklam Botu",
            process_id=111,
            class_name="TkTopLevel",
            client_width=1920,
            client_height=1080,
        )
        game = bot_engine.WindowCandidate(
            hwnd=20,
            title="Legend Online Client",
            process_id=222,
            class_name="Chrome_WidgetWin_1",
            client_width=1024,
            client_height=768,
        )

        selected = bot_engine.select_window_candidate(
            [own_gui, game],
            "Legend Online",
            current_process_id=111,
        )

        self.assertIsNotNone(selected)
        self.assertEqual(selected.hwnd, 20)

    def test_render_child_is_preferred_over_generic_container(self):
        generic = bot_engine.ChildCandidate(
            hwnd=30,
            class_name="GenericContainer",
            left=0,
            top=0,
            right=1200,
            bottom=800,
        )
        cef = bot_engine.ChildCandidate(
            hwnd=40,
            class_name="Chrome_RenderWidgetHostHWND",
            left=0,
            top=0,
            right=1200,
            bottom=800,
        )

        selected = bot_engine.select_input_child([generic, cef], 350, 700)

        self.assertIsNotNone(selected)
        self.assertEqual(selected.hwnd, 40)

    def test_smallest_containing_child_wins_without_known_render_class(self):
        large = bot_engine.ChildCandidate(30, "Container", 0, 0, 1200, 800)
        small = bot_engine.ChildCandidate(31, "EditSurface", 100, 600, 500, 780)

        selected = bot_engine.select_input_child([large, small], 350, 700)

        self.assertIsNotNone(selected)
        self.assertEqual(selected.hwnd, 31)

    def test_outside_children_returns_parent_fallback_signal(self):
        child = bot_engine.ChildCandidate(30, "Container", 0, 0, 100, 100)
        self.assertIsNone(bot_engine.select_input_child([child], 350, 700))


class CoordinateTests(unittest.TestCase):
    def test_lparam_packs_client_coordinates(self):
        self.assertEqual(bot_engine.make_lparam(353, 944), (944 << 16) | 353)

    def test_client_point_must_stay_inside_window(self):
        with patch.object(bot_engine, "get_client_size", return_value=(1024, 768)):
            self.assertEqual(
                bot_engine.validate_client_point(99, 100, 200),
                (1024, 768),
            )
            with self.assertRaises(bot_engine.CoordinateError):
                bot_engine.validate_client_point(99, 100, 944)


class EngineDeliveryTests(unittest.TestCase):
    def test_new_run_waits_until_previous_worker_has_fully_stopped(self):
        engine = bot_engine.LegendBotEngine(log_callback=lambda _message: None)
        engine._thread = Mock()
        engine._thread.is_alive.return_value = True

        self.assertFalse(engine.start())

    def test_background_delivery_uses_the_resolved_child_for_text_and_enter(self):
        engine = bot_engine.LegendBotEngine()
        engine.mode = "postmessage"
        engine.click_x = 353
        engine.click_y = 700
        target = bot_engine.InputTarget(
            hwnd=456,
            client_x=353,
            client_y=700,
            class_name="Chrome_RenderWidgetHostHWND",
        )

        with (
            patch.object(bot_engine, "post_click", return_value=target) as click,
            patch.object(bot_engine, "post_type_text") as type_text,
            patch.object(bot_engine, "post_enter") as enter,
            patch.object(bot_engine.time, "sleep"),
        ):
            delivered = engine._deliver_message(123, "reklam")

        self.assertEqual(delivered, target)
        click.assert_called_once_with(123, 353, 700)
        type_text.assert_called_once_with(456, "reklam")
        enter.assert_called_once_with(456)

    def test_failed_hwnd_delivery_is_not_counted_and_forces_reacquire(self):
        engine = bot_engine.LegendBotEngine(
            log_callback=lambda _message: None,
            status_callback=lambda _status: None,
        )
        engine.target_hwnd = 123
        engine.target_title = "Legend Online Client"

        with (
            patch.object(bot_engine.user32, "IsWindow", return_value=True),
            patch.object(
                engine,
                "_deliver_message",
                side_effect=bot_engine.BackgroundInputError("timeout"),
            ),
        ):
            delivered = engine._send_message("reklam", 1)

        self.assertFalse(delivered)
        self.assertEqual(engine.total_messages_sent, 0)
        self.assertIsNone(engine.target_hwnd)

    def test_test_send_restores_gui_settings_after_failure(self):
        engine = bot_engine.LegendBotEngine(log_callback=lambda _message: None)
        engine.click_x = 10
        engine.click_y = 20
        engine.mode = "postmessage"

        with (
            patch.object(
                bot_engine,
                "find_window_by_keyword",
                return_value=(123, "Legend Online Client"),
            ),
            patch.object(
                engine,
                "_deliver_message",
                side_effect=bot_engine.BackgroundInputError("timeout"),
            ),
        ):
            result = engine.test_send_once(
                "reklam",
                click_x=30,
                click_y=40,
                mode="sendinput",
            )

        self.assertFalse(result)
        self.assertEqual((engine.click_x, engine.click_y), (10, 20))
        self.assertEqual(engine.mode, "postmessage")


@unittest.skipUnless(sys.platform == "win32", "Win32 HWND entegrasyon testi")
class WindowsApiIntegrationTests(unittest.TestCase):
    def test_real_hidden_edit_hwnd_accepts_background_click_and_text(self):
        user32 = bot_engine.user32
        user32.CreateWindowExW.restype = ctypes.wintypes.HWND
        user32.CreateWindowExW.argtypes = [
            ctypes.wintypes.DWORD,
            ctypes.wintypes.LPCWSTR,
            ctypes.wintypes.LPCWSTR,
            ctypes.wintypes.DWORD,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.wintypes.HWND,
            ctypes.wintypes.HMENU,
            ctypes.wintypes.HINSTANCE,
            ctypes.c_void_p,
        ]
        user32.DestroyWindow.restype = ctypes.c_bool
        user32.DestroyWindow.argtypes = [ctypes.wintypes.HWND]

        # WS_OVERLAPPEDWINDOW | ES_MULTILINE; pencere görünür yapılmaz.
        hwnd = user32.CreateWindowExW(
            0,
            "EDIT",
            "",
            0x00CF0000 | 0x0004,
            100,
            100,
            400,
            200,
            None,
            None,
            None,
            None,
        )
        self.assertTrue(hwnd)

        try:
            target = bot_engine.post_click(hwnd, 10, 10)
            bot_engine.post_type_text(target.hwnd, "HWND42")

            length = user32.GetWindowTextLengthW(hwnd)
            buffer = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buffer, length + 1)

            self.assertEqual(target.hwnd, hwnd)
            self.assertEqual(buffer.value, "HWND42")
        finally:
            user32.DestroyWindow(hwnd)


if __name__ == "__main__":
    unittest.main()
