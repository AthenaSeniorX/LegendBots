import cv2
import os

UPLOADED_DIR = r"C:\Users\huigf\.gemini\antigravity\brain\a2a25190-287d-481a-b4b8-49da36908755\.user_uploaded"
TEMPLATES_DIR = r"c:\Users\huigf\LegendBots\ChatAdvertiserBot\templates"

img4_path = os.path.join(UPLOADED_DIR, "media__1784802998726.png")
img4 = cv2.imread(img4_path)

input_tmpl = cv2.imread(os.path.join(TEMPLATES_DIR, "exact_input_box.png"))
res = cv2.matchTemplate(img4, input_tmpl, cv2.TM_CCOEFF_NORMED)
_, max_val, _, max_loc = cv2.minMaxLoc(res)

center_x = max_loc[0] + input_tmpl.shape[1] // 2
center_y = max_loc[1] + input_tmpl.shape[0] // 2

print(f"Exact Input Box Match Confidence: {max_val}")
print(f"Exact Input Box Center Coordinates: x={center_x}, y={center_y}")

btn_tmpl = cv2.imread(os.path.join(TEMPLATES_DIR, "satin_al_btn.png"))
res_btn = cv2.matchTemplate(img4, btn_tmpl, cv2.TM_CCOEFF_NORMED)
_, max_val_btn, _, max_loc_btn = cv2.minMaxLoc(res_btn)

btn_center_x = max_loc_btn[0] + btn_tmpl.shape[1] // 2
btn_center_y = max_loc_btn[1] + btn_tmpl.shape[0] // 2

print(f"Satın Al Button Center Coordinates: x={btn_center_x}, y={btn_center_y}")
