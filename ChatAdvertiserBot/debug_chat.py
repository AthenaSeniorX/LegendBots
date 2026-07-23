import cv2
import os

UPLOADED_DIR = r"C:\Users\huigf\.gemini\antigravity\brain\a2a25190-287d-481a-b4b8-49da36908755\.user_uploaded"
TEMPLATES_DIR = r"c:\Users\huigf\LegendBots\ChatAdvertiserBot\templates"

img2_path = os.path.join(UPLOADED_DIR, "media__1784802820137.jpg")
img2 = cv2.imread(img2_path)
h, w = img2.shape[:2]

# Crop bottom-left region (where chat is located)
# Chat box in Görsel 2 is in the bottom left
chat_region = img2[int(h * 0.7):h, 0:int(w * 0.5)]

emoji = cv2.imread(os.path.join(TEMPLATES_DIR, "emoji_icon.png"))
res = cv2.matchTemplate(chat_region, emoji, cv2.TM_CCOEFF_NORMED)
min_val, max_val, min_loc, max_loc = cv2.minMaxLoc(res)

print(f"Chat Region Match Max Confidence: {max_val}")
print(f"Max Loc in Region: {max_loc}")

# Global position
global_x = max_loc[0] + emoji.shape[1] // 2
global_y = int(h * 0.7) + max_loc[1] + emoji.shape[0] // 2

print(f"Global Chat Emoji Position: x={global_x}, y={global_y}")
print(f"Chat Input Click Position (to left of emoji): x={global_x - 70}, y={global_y}")
