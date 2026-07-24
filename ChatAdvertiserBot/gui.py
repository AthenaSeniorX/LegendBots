import tkinter as tk
from tkinter import ttk, messagebox
import config
from bot_engine import LegendBotEngine, find_window_by_keyword

class BotGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("Legend Online - Arka Plan Chat Reklam Botu v3.0")
        self.root.geometry("680x820")
        self.root.minsize(640, 780)
        self.root.configure(bg="#1e1e2e")

        self.engine = LegendBotEngine(
            log_callback=self.log_message,
            alert_callback=self.show_alert,
            status_callback=self.update_status,
            counter_callback=self.update_counters
        )

        self._build_ui()

    def _build_ui(self):
        style = ttk.Style()
        style.theme_use('clam')
        style.configure(".", background="#1e1e2e", foreground="#cdd6f4", font=("Segoe UI", 10))
        style.configure("TLabel", background="#1e1e2e", foreground="#cdd6f4")
        style.configure("TLabelframe", background="#1e1e2e", foreground="#89b4fa")
        style.configure("TLabelframe.Label", background="#1e1e2e", foreground="#89b4fa", font=("Segoe UI", 11, "bold"))
        style.configure("TEntry", foreground="black", fieldbackground="white")

        # Header Title Banner
        header_frame = tk.Frame(self.root, bg="#313244", pady=10)
        header_frame.pack(fill="x")

        title_label = tk.Label(
            header_frame, 
            text="LEGEND ONLINE CHAT BOT v3.0", 
            font=("Segoe UI", 14, "bold"), 
            bg="#313244", 
            fg="#a6e3a1"
        )
        title_label.pack()

        subtitle_label = tk.Label(
            header_frame, 
            text="Kesintisiz Arka Plan Modu (RDP Kapalıyken %100 Çalışır)", 
            font=("Segoe UI", 9), 
            bg="#313244", 
            fg="#bac2de"
        )
        subtitle_label.pack()

        main_container = tk.Frame(self.root, bg="#1e1e2e", padx=15, pady=10)
        main_container.pack(fill="both", expand=True)

        # 1. Counter Display Panel
        stats_frame = tk.Frame(main_container, bg="#313244", pady=8, padx=10)
        stats_frame.pack(fill="x", pady=5)

        self.lbl_sent_counter = tk.Label(
            stats_frame,
            text="Gönderilen Mesaj: 0",
            font=("Segoe UI", 11, "bold"),
            bg="#313244",
            fg="#89b4fa"
        )
        self.lbl_sent_counter.pack(side="left", padx=10)

        self.lbl_window_status = tk.Label(
            stats_frame,
            text="Hedef Pencere: —",
            font=("Segoe UI", 10),
            bg="#313244",
            fg="#f9e2af"
        )
        self.lbl_window_status.pack(side="right", padx=10)

        # 2. Win32 Hedef Pencere & Koordinat Ayarları
        target_frame = ttk.LabelFrame(main_container, text=" Hedef Pencere & Koordinat Ayarları ", padding=10)
        target_frame.pack(fill="x", pady=5)

        # Pencere başlığı
        ttk.Label(target_frame, text="Pencere Başlığı:").grid(row=0, column=0, sticky="w", pady=2)
        self.entry_window_keyword = ttk.Entry(target_frame, width=35)
        self.entry_window_keyword.insert(0, config.WINDOW_TITLE_KEYWORD)
        self.entry_window_keyword.grid(row=0, column=1, padx=5, pady=2, sticky="ew")

        self.btn_find_window = tk.Button(
            target_frame,
            text="🔍 Pencereyi Bul",
            font=("Segoe UI", 9, "bold"),
            bg="#89b4fa",
            fg="#11111b",
            relief="flat",
            padx=8, pady=2,
            command=self.test_find_window
        )
        self.btn_find_window.grid(row=0, column=2, padx=5, pady=2)

        # Koordinatlar
        ttk.Label(target_frame, text="Chat Tıklama X:").grid(row=1, column=0, sticky="w", pady=2)
        self.entry_click_x = ttk.Entry(target_frame, width=12)
        self.entry_click_x.insert(0, str(config.DEFAULT_CLICK_X))
        self.entry_click_x.grid(row=1, column=1, padx=5, pady=2, sticky="w")

        ttk.Label(target_frame, text="Chat Tıklama Y:").grid(row=2, column=0, sticky="w", pady=2)
        self.entry_click_y = ttk.Entry(target_frame, width=12)
        self.entry_click_y.insert(0, str(config.DEFAULT_CLICK_Y))
        self.entry_click_y.grid(row=2, column=1, padx=5, pady=2, sticky="w")

        # Çalışma Modu Seçimi
        ttk.Label(target_frame, text="Çalışma Modu:").grid(row=3, column=0, sticky="w", pady=(8, 2))
        
        self.mode_var = tk.StringVar(value="postmessage")
        
        mode_radio_frame = tk.Frame(target_frame, bg="#1e1e2e")
        mode_radio_frame.grid(row=3, column=1, columnspan=2, sticky="w", pady=(8, 2))

        rb_pm = tk.Radiobutton(
            mode_radio_frame,
            text="Arka Plan (PostMessage — RDP Kapalıyken %100 Çalışır)",
            variable=self.mode_var,
            value="postmessage",
            bg="#1e1e2e",
            fg="#a6e3a1",
            selectcolor="#313244",
            activebackground="#1e1e2e",
            activeforeground="#a6e3a1",
            font=("Segoe UI", 9, "bold")
        )
        rb_pm.pack(anchor="w")

        rb_si = tk.Radiobutton(
            mode_radio_frame,
            text="Ön Plan (SendInput — Fiziksel Fare)",
            variable=self.mode_var,
            value="sendinput",
            bg="#1e1e2e",
            fg="#cdd6f4",
            selectcolor="#313244",
            activebackground="#1e1e2e",
            activeforeground="#cdd6f4",
            font=("Segoe UI", 9)
        )
        rb_si.pack(anchor="w")

        # Test Butonu
        self.btn_test_once = tk.Button(
            target_frame,
            text="🧪 TEST MESAJI GÖNDER (1 KEZ)",
            font=("Segoe UI", 9, "bold"),
            bg="#f9e2af",
            fg="#11111b",
            relief="flat",
            padx=10, pady=4,
            command=self.test_send_once
        )
        self.btn_test_once.grid(row=4, column=0, columnspan=3, pady=(10, 2), sticky="ew")

        target_frame.columnconfigure(1, weight=1)

        # 3. Message Settings Group
        msg_frame = ttk.LabelFrame(main_container, text=" Mesaj Ayarları ", padding=10)
        msg_frame.pack(fill="x", pady=5)

        ttk.Label(msg_frame, text="1. Mesaj:").grid(row=0, column=0, sticky="w", pady=2)
        self.entry_msg1 = ttk.Entry(msg_frame, width=65)
        self.entry_msg1.insert(0, config.DEFAULT_MESSAGE_1)
        self.entry_msg1.grid(row=0, column=1, padx=5, pady=2, sticky="ew")

        ttk.Label(msg_frame, text="2. Mesaj:").grid(row=1, column=0, sticky="w", pady=2)
        self.entry_msg2 = ttk.Entry(msg_frame, width=65)
        self.entry_msg2.insert(0, config.DEFAULT_MESSAGE_2)
        self.entry_msg2.grid(row=1, column=1, padx=5, pady=2, sticky="ew")

        msg_frame.columnconfigure(1, weight=1)

        # 4. Timing Settings Group
        settings_frame = ttk.LabelFrame(main_container, text=" Zamanlama Ayarları ", padding=10)
        settings_frame.pack(fill="x", pady=5)

        ttk.Label(settings_frame, text="Mesajlar Arası Bekleme (sn):").grid(row=0, column=0, sticky="w")
        self.entry_inter_delay = ttk.Entry(settings_frame, width=8)
        self.entry_inter_delay.insert(0, str(config.INTER_MESSAGE_DELAY))
        self.entry_inter_delay.grid(row=0, column=1, sticky="w", padx=5)

        ttk.Label(settings_frame, text="Reklam Döngü Aralığı (sn):").grid(row=0, column=2, sticky="e", padx=(20, 5))
        self.entry_interval = ttk.Entry(settings_frame, width=8)
        self.entry_interval.insert(0, str(config.DEFAULT_CYCLE_INTERVAL))
        self.entry_interval.grid(row=0, column=3, sticky="w")

        # 5. Action Buttons Frame
        btn_frame = tk.Frame(main_container, bg="#1e1e2e")
        btn_frame.pack(fill="x", pady=10)

        self.btn_start = tk.Button(
            btn_frame, 
            text="▶ BAŞLAT", 
            font=("Segoe UI", 11, "bold"),
            bg="#a6e3a1", 
            fg="#11111b",
            activebackground="#94e2d5",
            relief="flat",
            padx=15, pady=6,
            command=self.start_bot
        )
        self.btn_start.pack(side="left", padx=5)

        self.btn_pause = tk.Button(
            btn_frame, 
            text="⏸ DURAKLAT", 
            font=("Segoe UI", 11, "bold"),
            bg="#fab387", 
            fg="#11111b",
            activebackground="#f9e2af",
            relief="flat",
            padx=15, pady=6,
            command=self.pause_bot
        )
        self.btn_pause.pack(side="left", padx=5)

        self.btn_stop = tk.Button(
            btn_frame, 
            text="⏹ DURDUR (F8)", 
            font=("Segoe UI", 11, "bold"),
            bg="#f38ba8", 
            fg="#11111b",
            activebackground="#eba0ac",
            relief="flat",
            padx=15, pady=6,
            command=self.stop_bot
        )
        self.btn_stop.pack(side="left", padx=5)

        self.lbl_status = tk.Label(
            btn_frame, 
            text="DURUM: DURDURULDU", 
            font=("Segoe UI", 10, "bold"),
            bg="#313244", 
            fg="#f38ba8",
            padx=10, pady=6
        )
        self.lbl_status.pack(side="right", padx=5)

        # 6. Console Log Group
        log_frame = ttk.LabelFrame(main_container, text=" İşlem Günlüğü (Console Log) ", padding=5)
        log_frame.pack(fill="both", expand=True, pady=5)

        self.txt_log = tk.Text(
            log_frame, 
            wrap="word", 
            font=("Consolas", 9),
            bg="#11111b", 
            fg="#cdd6f4",
            insertbackground="#cdd6f4"
        )
        scrollbar = ttk.Scrollbar(log_frame, command=self.txt_log.yview)
        self.txt_log.configure(yscrollcommand=scrollbar.set)

        scrollbar.pack(side="right", fill="y")
        self.txt_log.pack(side="left", fill="both", expand=True)

        self.root.bind("<F8>", lambda e: self.stop_bot())

    def test_find_window(self):
        keyword = self.entry_window_keyword.get().strip()
        if not keyword:
            messagebox.showerror("Hata", "Pencere başlığı anahtar kelimesi boş olamaz!")
            return

        result = find_window_by_keyword(keyword)
        if result:
            hwnd, title = result
            self.lbl_window_status.config(
                text=f"✅ Bulundu: {title[:35]}...",
                fg="#a6e3a1"
            )
            self.log_message(f"[{__import__('time').strftime('%H:%M:%S')}] ✅ Pencere bulundu: '{title}' (HWND: {hwnd})")
        else:
            self.lbl_window_status.config(
                text=f"❌ '{keyword}' bulunamadı",
                fg="#f38ba8"
            )
            self.log_message(f"[{__import__('time').strftime('%H:%M:%S')}] ❌ '{keyword}' başlıklı pencere bulunamadı!")

    def test_send_once(self):
        msg1 = self.entry_msg1.get().strip()
        keyword = self.entry_window_keyword.get().strip()
        mode = self.mode_var.get()
        try:
            click_x = int(self.entry_click_x.get().strip())
            click_y = int(self.entry_click_y.get().strip())
        except ValueError:
            messagebox.showerror("Hata", "X ve Y koordinatları geçerli sayı olmalıdır!")
            return

        if not msg1:
            messagebox.showerror("Hata", "1. Mesaj boş olamaz!")
            return

        self.engine.test_send_once(
            text=msg1,
            click_x=click_x,
            click_y=click_y,
            keyword=keyword,
            mode=mode
        )

    def start_bot(self):
        msg1 = self.entry_msg1.get().strip()
        msg2 = self.entry_msg2.get().strip()
        interval = self.entry_interval.get().strip()
        keyword = self.entry_window_keyword.get().strip()
        mode = self.mode_var.get()

        if not msg1 or not msg2:
            messagebox.showerror("Hata", "Mesaj alanları boş bırakılamaz!")
            return

        if not keyword:
            messagebox.showerror("Hata", "Pencere başlığı anahtar kelimesi boş olamaz!")
            return

        try:
            click_x = int(self.entry_click_x.get().strip())
            click_y = int(self.entry_click_y.get().strip())
        except ValueError:
            messagebox.showerror("Hata", "X ve Y koordinatları sayı olmalıdır!")
            return

        try:
            inter_delay = float(self.entry_inter_delay.get().strip())
            self.engine.inter_delay = inter_delay
        except ValueError:
            pass

        self.engine.start(
            msg1=msg1,
            msg2=msg2,
            interval=interval,
            click_x=click_x,
            click_y=click_y,
            keyword=keyword,
            mode=mode
        )

    def pause_bot(self):
        self.engine.pause()

    def stop_bot(self):
        self.engine.stop()

    def update_status(self, status_text):
        colors = {
            "Çalışıyor": "#a6e3a1",
            "Duraklatıldı": "#fab387",
            "Durduruldu": "#f38ba8"
        }
        fg_color = colors.get(status_text, "#cdd6f4")
        self.lbl_status.config(text=f"DURUM: {status_text.upper()}", fg=fg_color)

    def update_counters(self, messages_sent):
        def _update():
            self.lbl_sent_counter.config(text=f"Gönderilen Mesaj: {messages_sent}")
        self.root.after(0, _update)

    def log_message(self, text):
        def _append():
            self.txt_log.insert(tk.END, text + "\n")
            self.txt_log.see(tk.END)
        self.root.after(0, _append)

    def show_alert(self, title, message):
        def _alert():
            alert_win = tk.Toplevel(self.root)
            alert_win.title(title)
            alert_win.geometry("440x200")
            alert_win.configure(bg="#f38ba8")
            alert_win.attributes("-topmost", True)
            alert_win.grab_set()

            alert_win.update_idletasks()
            x = (alert_win.winfo_screenwidth() // 2) - (440 // 2)
            y = (alert_win.winfo_screenheight() // 2) - (200 // 2)
            alert_win.geometry(f"+{x}+{y}")

            lbl_header = tk.Label(
                alert_win, 
                text="⚠️ UYARI", 
                font=("Segoe UI", 16, "bold"), 
                bg="#f38ba8", 
                fg="#11111b"
            )
            lbl_header.pack(pady=(15, 5))

            lbl_msg = tk.Label(
                alert_win, 
                text=message, 
                font=("Segoe UI", 11), 
                bg="#f38ba8", 
                fg="#11111b",
                justify="center",
                wraplength=400
            )
            lbl_msg.pack(pady=10)

            btn_ok = tk.Button(
                alert_win, 
                text="TAMAM", 
                font=("Segoe UI", 11, "bold"),
                bg="#11111b", 
                fg="#f38ba8",
                relief="flat",
                padx=15, pady=5,
                command=alert_win.destroy
            )
            btn_ok.pack(pady=10)

        self.root.after(0, _alert)
