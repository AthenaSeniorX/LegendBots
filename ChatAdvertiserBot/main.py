import sys
import os
import tkinter as tk
from gui import BotGUI

# Ensure current working directory is in sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def main():
    root = tk.Tk()
    app = BotGUI(root)
    root.mainloop()

if __name__ == "__main__":
    main()
