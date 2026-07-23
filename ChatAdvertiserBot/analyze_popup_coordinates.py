import cv2
import os

UPLOADED_DIR = r"C:\Users\huigf\.gemini\antigravity\brain\a2a25190-287d-481a-b4b8-49da36908755\.user_uploaded"
img4_path = os.path.join(UPLOADED_DIR, "media__1784802998726.png")
img4 = cv2.imread(img4_path)
h, w = img4.shape[:2]

print(f"Görsel 4 dimensions: width={w}, height={h}")

# Header "Satın Al" text is around top (y: 10 to 45)
# Item icon "Borazan" is around y: 70 to 145
# "Alış Miktarı:" label is at y: 175 to 210
# The input box with number "1" inside is located at:
# x: ~125 to ~210 (center x ≈ 168)
# y: ~180 to ~210 (center y ≈ 195)
# "Satın Al" button at bottom right is at:
# x: ~170 to ~290 (center x ≈ 230)
# y: ~255 to ~295 (center y ≈ 275)

# Let's crop EXACT ONLY the inner dark input box containing "1"
# Input box coordinates in media__1784802998726.png:
# y range: 184 to 210
# x range: 128 to 212
input_box_exact = img4[184:210, 128:212]
TEMPLATES_DIR = r"c:\Users\huigf\LegendBots\ChatAdvertiserBot\templates"
cv2.imwrite(os.path.join(TEMPLATES_DIR, "exact_input_box.png"), input_box_exact)

# Crop EXACT "1" number digit inside input box
num_1_exact = img4[188:206, 160:180]
cv2.imwrite(os.path.join(TEMPLATES_DIR, "num_1_digit.png"), num_1_exact)

print("Exact input box cropped successfully!")

# Calculate exact relative offsets from header (center header x≈160, y≈25):
# Input box center: x = 168, y = 197 -> Offset from header: dx = +8, dy = +172
# Button center: x = 230, y = 275 -> Offset from header: dx = +70, dy = +250
# Button center: x = 230, y = 275 -> Offset from input box (168, 197): dx = +62, dy = +78
