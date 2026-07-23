import tkinter as tk
from tkinter import ttk, messagebox
import config
from bot_engine import LegendBotEngine

class BotGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("Legend Online - Otomatik Chat & Borazan Botu v1.0")
        self.root.geometry("640x720")
        self.root.minsize(600, 680)
        self.root.configure(bg="#1e1e2e")

        self.engine = LegendBotEngine(
            log_callback=self.log_message,
            alert_callback=self.show_haklarimiz_bitti_alert,
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

        # Header Title Banner
        header_frame = tk.Frame(self.root, bg="#313244", pady=10)
        header_frame.pack(fill="x")

        title_label = tk.Label(
            header_frame, 
            text="LEGEND ONLINE CHAT BOT", 
            font=("Segoe UI", 14, "bold"), 
            bg="#313244", 
            fg="#a6e3a1"
        )
        title_label.pack()

        subtitle_label = tk.Label(
            header_frame, 
            text="Otomatik Reklam & 666 Borazan Takip Sistemi", 
            font=("Segoe UI", 9), 
            bg="#313244", 
            fg="#bac2de"
        )
        subtitle_label.pack()

        main_container = tk.Frame(self.root, bg="#1e1e2e", padx=15, pady=10)
        main_container.pack(fill="both", expand=True)

        # 1. Counter Display Panel (Live Stats)
        stats_frame = tk.Frame(main_container, bg="#313244", pady=8, padx=10)
        stats_frame.pack(fill="x", pady=5)

        self.lbl_sent_counter = tk.Label(
            stats_frame,
            text="Gönderilen Mesaj: 0 / 666",
            font=("Segoe UI", 11, "bold"),
            bg="#313244",
            fg="#89b4fa"
        )
        self.lbl_sent_counter.pack(side="left", padx=10)

        self.lbl_purchase_counter = tk.Label(
            stats_frame,
            text="Satın Alma Ekranı: 0 / 2",
            font=("Segoe UI", 11, "bold"),
            bg="#313244",
            fg="#f9e2af"
        )
        self.lbl_purchase_counter.pack(side="right", padx=10)

        # 2. Message Settings Group
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

        # 3. Timing & Purchase Settings Group
        settings_frame = ttk.LabelFrame(main_container, text=" Zamanlama & Satın Alma Ayarları ", padding=10)
        settings_frame.pack(fill="x", pady=5)

        ttk.Label(settings_frame, text="Mesajlar Arası Bekleme:").grid(row=0, column=0, sticky="w")
        ttk.Label(settings_frame, text="1.0 Saniye (Sabit)", font=("Segoe UI", 9, "bold"), foreground="#fab387").grid(row=0, column=1, sticky="w", padx=5)

        ttk.Label(settings_frame, text="Reklam Döngü Aralığı (sn):").grid(row=0, column=2, sticky="e", padx=(20, 5))
        self.entry_interval = ttk.Entry(settings_frame, width=8)
        self.entry_interval.insert(0, str(config.DEFAULT_CYCLE_INTERVAL))
        self.entry_interval.grid(row=0, column=3, sticky="w")

        ttk.Label(settings_frame, text="Satın Alınacak Borazan Miktarı:").grid(row=1, column=0, sticky="w", pady=(8,0))
        self.entry_quantity = ttk.Entry(settings_frame, width=8)
        self.entry_quantity.insert(0, config.PURCHASE_QUANTITY)
        self.entry_quantity.grid(row=1, column=1, sticky="w", pady=(8,0), padx=5)

        ttk.Label(settings_frame, text="Maksimum Satın Alma Limiti:").grid(row=1, column=2, sticky="e", pady=(8,0), padx=(20, 5))
        ttk.Label(settings_frame, text="1 Defa (2. Ekran = UYARI)", font=("Segoe UI", 9, "bold"), foreground="#f38ba8").grid(row=1, column=3, sticky="w", pady=(8,0))

        # 4. Action Buttons Frame
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

        # 5. Console Log Group
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

    def start_bot(self):
        msg1 = self.entry_msg1.get().strip()
        msg2 = self.entry_msg2.get().strip()
        interval = self.entry_interval.get().strip()
        quantity = self.entry_quantity.get().strip()

        if not msg1 or not msg2:
            messagebox.showerror("Hata", "Mesaj alanları boş bırakılamaz!")
            return

        self.engine.purchase_quantity = quantity if quantity else config.PURCHASE_QUANTITY
        self.engine.start(msg1=msg1, msg2=msg2, interval=interval)

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

    def update_counters(self, messages_sent, purchase_count):
        def _update():
            self.lbl_sent_counter.config(text=f"Gönderilen Mesaj: {messages_sent} / 666")
            self.lbl_purchase_counter.config(text=f"Satın Alma Ekranı: {purchase_count} / 2")
        self.root.after(0, _update)

    def log_message(self, text):
        def _append():
            self.txt_log.insert(tk.END, text + "\n")
            self.txt_log.see(tk.END)
        self.root.after(0, _append)

    def show_haklarimiz_bitti_alert(self, title, message):
        """Displays custom warning alert window on main thread when limit is reached."""
        def _alert():
            alert_win = tk.Toplevel(self.root)
            alert_win.title(title)
            alert_win.geometry("440x240")
            alert_win.configure(bg="#f38ba8")
            alert_win.attributes("-topmost", True)
            alert_win.grab_set()

            alert_win.update_idletasks()
            x = (alert_win.winfo_screenwidth() // 2) - (440 // 2)
            y = (alert_win.winfo_screenheight() // 2) - (240 // 2)
            alert_win.geometry(f"+{x}+{y}")

            lbl_header = tk.Label(
                alert_win, 
                text="⛔ UYARI!", 
                font=("Segoe UI", 16, "bold"), 
                bg="#f38ba8", 
                fg="#11111b"
            )
            lbl_header.pack(pady=(15, 5))

            lbl_msg = tk.Label(
                alert_win, 
                text=f"HAKLARIMIZ BİTTİ!\n\nSatın alma ekranı 2. defa karşılaşıldı.\n666 Borazan mesajı tamamlandı ve haklar tükendi.", 
                font=("Segoe UI", 11, "bold"), 
                bg="#f38ba8", 
                fg="#11111b",
                justify="center"
            )
            lbl_msg.pack(pady=10)

            btn_ok = tk.Button(
                alert_win, 
                text="TAMAM (ANLADIM)", 
                font=("Segoe UI", 11, "bold"),
                bg="#11111b", 
                fg="#f38ba8",
                relief="flat",
                padx=15, pady=5,
                command=alert_win.destroy
            )
            btn_ok.pack(pady=10)

        self.root.after(0, _alert)
