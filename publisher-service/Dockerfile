FROM golang:1.24-bookworm AS douyin-builder
WORKDIR /src
COPY vendor/douyin-uploader/go.mod vendor/douyin-uploader/go.sum ./
RUN go mod download
COPY vendor/douyin-uploader/cmd ./cmd
COPY vendor/douyin-uploader/internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/douyin-uploader ./cmd/douyin-uploader

FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 DISPLAY=:99 PUBLISHER_CHROMIUM_HEADLESS=false
RUN apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install -y --no-install-recommends ffmpeg ca-certificates chromium fonts-noto-cjk xvfb \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY chromium-policy.json /etc/chromium/policies/managed/publisher.json
COPY requirements.txt ./
RUN pip install -r requirements.txt
COPY app ./app
COPY vendor/xhs-upload ./vendor/xhs-upload
COPY vendor/wechat-channels-upload ./vendor/wechat-channels-upload
COPY vendor/toutiao-auto-publisher ./vendor/toutiao-auto-publisher
COPY --from=douyin-builder /out/douyin-uploader /usr/local/bin/douyin-uploader
RUN useradd --create-home --uid 10001 publisher \
    && chown -R publisher:publisher /app
USER publisher
ENV PUBLISHER_CHROMIUM_HEADLESS=true
EXPOSE 8090
CMD ["sh", "-c", "Xvfb :99 -screen 0 1366x768x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & exec uvicorn app.main:app --host 0.0.0.0 --port 8090"]
