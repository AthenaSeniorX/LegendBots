import os
import sys
import cv2
import config
from bot_engine import LegendBotEngine

# Force UTF-8 output encoding for windows console
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

UPLOADED_DIR = r"C:\Users\huigf\.gemini\antigravity\brain\a2a25190-287d-481a-b4b8-49da36908755\.user_uploaded"

def run_dry_run_tests():
    print("--- RUNNING DRY-RUN TEMPLATE MATCHING TESTS ---")
    engine = LegendBotEngine()

    # Test 1: Full Game Screen (Görsel 2) -> Should detect Emoji in bottom-left and locate chat box
    img2_path = os.path.join(UPLOADED_DIR, "media__1784802820137.jpg")
    if os.path.exists(img2_path):
        screen_bgr = cv2.imread(img2_path)
        print(f"Loaded Görsel 2 (Game Screen): {screen_bgr.shape[1]}x{screen_bgr.shape[0]}")
        
        chat_pos = engine.locate_chat_box(screen_bgr=screen_bgr)
        if chat_pos:
            print(f"[SUCCESS] Located Chat Box accurately at position (x={chat_pos[0]}, y={chat_pos[1]})")
        else:
            print("[FAIL] Could not locate Chat Box in Görsel 2")

    # Test 2: Satın Al Popup Screen (Görsel 4) -> Should detect Satın Al modal signature
    img4_path = os.path.join(UPLOADED_DIR, "media__1784802998726.png")
    if os.path.exists(img4_path):
        screen_bgr4 = cv2.imread(img4_path)
        print(f"\nLoaded Görsel 4 (Satın Al Popup): {screen_bgr4.shape[1]}x{screen_bgr4.shape[0]}")
        
        header_match = engine.find_template("satin_al_header", confidence=0.60, region_bgr=screen_bgr4)
        item_match = engine.find_template("borazan_item", confidence=0.60, region_bgr=screen_bgr4)
        btn_match = engine.find_template("satin_al_btn", confidence=0.60, region_bgr=screen_bgr4)
        qty_match = engine.find_template("quantity_box", confidence=0.60, region_bgr=screen_bgr4)

        print(f"Header Match Confidence: {header_match['confidence'] if header_match else 'None'}")
        print(f"Item Match Confidence: {item_match['confidence'] if item_match else 'None'}")
        print(f"Button Match Confidence: {btn_match['confidence'] if btn_match else 'None'}")
        print(f"Quantity Field Match Confidence: {qty_match['confidence'] if qty_match else 'None'}")

        if header_match or item_match or btn_match:
            print("[SUCCESS] 'Satın Al' modal detected accurately!")
        else:
            print("[FAIL] Could not detect 'Satın Al' modal in Görsel 4")

if __name__ == "__main__":
    run_dry_run_tests()
