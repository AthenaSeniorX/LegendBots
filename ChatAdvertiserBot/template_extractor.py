import os
from PIL import Image

UPLOADED_DIR = r"C:\Users\huigf\.gemini\antigravity\brain\a2a25190-287d-481a-b4b8-49da36908755\.user_uploaded"
TEMPLATES_DIR = r"c:\Users\huigf\LegendBots\ChatAdvertiserBot\templates"

os.makedirs(TEMPLATES_DIR, exist_ok=True)

# 1. Emoji Icon from media__1784802863652.png (Görsel 3) or media__1784802778024.png
img_gorsel3_path = os.path.join(UPLOADED_DIR, "media__1784802863652.png")
if os.path.exists(img_gorsel3_path):
    img_emoji = Image.open(img_gorsel3_path)
    img_emoji.save(os.path.join(TEMPLATES_DIR, "emoji_icon.png"))
    print(f"Saved emoji_icon.png: {img_emoji.size}")

# 2. Satın Al Modal Header & Controls from media__1784802998726.png (Görsel 4)
img_gorsel4_path = os.path.join(UPLOADED_DIR, "media__1784802998726.png")
if os.path.exists(img_gorsel4_path):
    img_satin = Image.open(img_gorsel4_path)
    w, h = img_satin.size
    print(f"Görsel 4 size: {w}x{h}")
    
    # Save full modal as reference
    img_satin.save(os.path.join(TEMPLATES_DIR, "satin_al_modal_full.png"))
    
    # Crop Header "Satın Al" title area (top header part)
    header_crop = img_satin.crop((int(w * 0.25), 0, int(w * 0.75), int(h * 0.18)))
    header_crop.save(os.path.join(TEMPLATES_DIR, "satin_al_header.png"))
    
    # Crop Item Icon / Title "Borazan"
    borazan_crop = img_satin.crop((int(w * 0.15), int(h * 0.15), int(w * 0.65), int(h * 0.45)))
    borazan_crop.save(os.path.join(TEMPLATES_DIR, "borazan_item.png"))
    
    # Crop Quantity input box area (around "1")
    # In Görsel 4, "Alış Miktarı:" is on the left, input box with "1" is in center, + / - buttons to the right
    qty_crop = img_satin.crop((int(w * 0.35), int(h * 0.52), int(w * 0.68), int(h * 0.68)))
    qty_crop.save(os.path.join(TEMPLATES_DIR, "quantity_box.png"))
    
    # Crop "Satın Al" button (bottom right button)
    btn_crop = img_satin.crop((int(w * 0.50), int(h * 0.78), int(w * 0.95), int(h * 0.98)))
    btn_crop.save(os.path.join(TEMPLATES_DIR, "satin_al_btn.png"))
    print("Saved Satın Al templates successfully!")

# 3. Chat input / World chat tab signature from media__1784802778024.png (Görsel 1)
img_gorsel1_path = os.path.join(UPLOADED_DIR, "media__1784802778024.png")
if os.path.exists(img_gorsel1_path):
    img_chat = Image.open(img_gorsel1_path)
    cw, ch = img_chat.size
    print(f"Görsel 1 size: {cw}x{ch}")
    
    # Crop World Chat ("Dünya") tab button at bottom left
    dunya_crop = img_chat.crop((int(cw * 0.10), int(ch * 0.80), int(cw * 0.30), int(ch * 0.95)))
    dunya_crop.save(os.path.join(TEMPLATES_DIR, "dunya_tab.png"))
    
    # Crop Emoji button area from bottom right of chat box
    emoji_chat_crop = img_chat.crop((int(cw * 0.80), int(ch * 0.88), int(cw * 0.92), int(ch * 0.99)))
    emoji_chat_crop.save(os.path.join(TEMPLATES_DIR, "emoji_btn_in_chat.png"))
    print("Saved Chat templates successfully!")
