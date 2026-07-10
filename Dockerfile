FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . ./

ENV HOST=0.0.0.0 \
    PORT=8765 \
    AUTO_REFRESH_ENABLED=1 \
    AUTO_REFRESH_INTERVAL_MINUTES=60 \
    AUTO_REFRESH_STARTUP_DELAY_SECONDS=10 \
    AUTO_REFRESH_SKIP_PDF=0 \
    MANUAL_REFRESH_ENABLED=0 \
    PAGE_POLL_INTERVAL_SECONDS=60

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/health', timeout=3)"

CMD ["python", "server.py"]
