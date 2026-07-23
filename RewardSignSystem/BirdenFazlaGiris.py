import http.server
import socketserver

class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        # Sunucuya isteği ilet
        self.send_request_to_server()

    def send_request_to_server(self):
        import requests

        # Orijinal sunucu URL'si
        target_url = "http://s1328oastr.creaction-network.com" + self.path

        # İstemciden gelen isteği logla
        print(f"Gelen İstek: {self.path}")

        # Sunucuya istek gönder
        response = requests.get(target_url)

        # Orijinal yanıtı logla
        print(f"Orijinal Yanıt: {response.text}")

        # Yanıtı manipüle et
        manipulated_content = response.text.replace("|6", "|0")  # Cevabı manipüle et

        # Manipüle edilmiş yanıtı logla
        print(f"Manipüle Edilmiş Yanıt: {manipulated_content}")

        # Manipüle edilen yanıtı istemciye gönder
        self.send_response(200)  # HTTP 200 Durum Kodu
        self.end_headers()
        self.wfile.write(manipulated_content.encode())

# Proxy sunucusunu başlat
PORT = 8888
with socketserver.TCPServer(("", PORT), ProxyHandler) as httpd:
    print(f"Proxy sunucusu {PORT} portunda çalışıyor...")
    httpd.serve_forever()
