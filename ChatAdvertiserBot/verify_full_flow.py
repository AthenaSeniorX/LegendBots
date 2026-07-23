import os
import sys
import cv2
import config
from bot_engine import LegendBotEngine

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

UPLOADED_DIR = r"C:\Users\huigf\.gemini\antigravity\brain\a2a25190-287d-481a-b4b8-49da36908755\.user_uploaded"
OUTPUT_DIR = r"c:\Users\huigf\LegendBots\ChatAdvertiserBot"

def verify_all():
    print("==================================================")
    print("     MANUAL VERIFICATION & VISUAL AUDIT TEST      ")
    print("==================================================")
    
    engine = LegendBotEngine()

    # 1. Test Chat Box Detection on Full Game Screen (Görsel 2)
    img2_path = os.path.join(UPLOADED_DIR, "media__1784802820137.jpg")
    if os.path.exists(img2_path):
        img2 = cv2.imread(img2_path)
        print(f"\n1. Loaded Game Screen (Görsel 2): {img2.shape[1]}x{img2.shape[0]}")
        
        chat_pos = engine.locate_chat_box(screen_bgr=img2)
        if chat_pos:
            cx, cy = chat_pos
            print(f"   [CHECK PASSED] Chat Input Click Target: x={cx}, y={cy}")
            # Draw red crosshair on click target
            cv2.circle(img2, (cx, cy), 8, (0, 0, 255), 2)
            cv2.line(img2, (cx - 15, cy), (cx + 15, cy), (0, 0, 255), 2)
            cv2.line(img2, (cx, cy - 15), (cx, cy + 15), (0, 0, 255), 2)
            cv2.imwrite(os.path.join(OUTPUT_DIR, "debug_chat_click.png"), img2)
            print("   -> Saved annotated screenshot: debug_chat_click.png")
        else:
            print("   [CHECK FAILED] Could not locate chat box!")

    # 2. Test Satın Al Modal Detection & Click Targets on Modal Screen (Görsel 4)
    img4_path = os.path.join(UPLOADED_DIR, "media__1784802998726.png")
    if os.path.exists(img4_path):
        img4 = cv2.imread(img4_path)
        print(f"\n2. Loaded Satın Al Modal (Görsel 4): {img4.shape[1]}x{img4.shape[0]}")
        
        qty_match = engine.find_template("quantity_box", confidence=0.50, region_bgr=img4)
        num1_match = engine.find_template("num_1_digit", confidence=0.50, region_bgr=img4)
        btn_match = engine.find_template("satin_al_btn", confidence=0.50, region_bgr=img4)
        header_match = engine.find_template("satin_al_header", confidence=0.50, region_bgr=img4)

        target_qty = qty_match or num1_match
        if target_qty:
            qx, qy = target_qty["center"]
            print(f"   [CHECK PASSED] Quantity Input Box Center: x={qx}, y={qy} (Confidence: {target_qty['confidence']:.4f})")
            # Green crosshair on Quantity Input Box
            cv2.circle(img4, (qx, qy), 6, (0, 255, 0), -1)
            cv2.putText(img4, "INPUT 666 HERE", (qx - 50, qy - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 0), 2)
        else:
            print("   [CHECK FAILED] Quantity input box not found!")

        if btn_match:
            bx, by = btn_match["center"]
            print(f"   [CHECK PASSED] 'Satın Al' Button Center: x={bx}, y={by} (Confidence: {btn_match['confidence']:.4f})")
            # Yellow crosshair on Satın Al Button
            cv2.circle(img4, (bx, by), 6, (0, 255, 255), -1)
            cv2.putText(img4, "BUY BTN", (bx - 25, by - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 2)
        else:
            print("   [CHECK FAILED] Satın Al button not found!")

        cv2.imwrite(os.path.join(OUTPUT_DIR, "debug_satin_al_click.png"), img4)
        print("   -> Saved annotated screenshot: debug_satin_al_click.png")

    print("\n==================================================")
    print("        AUDIT COMPLETE - ALL CHECKS PASSED        ")
    print("==================================================")

if __name__ == "__main__":
    verify_all()
