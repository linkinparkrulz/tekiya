# Publishes the dashboard on the host's loopback while the app container
# stays on the internal network with no direct internet access.
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends socat \
    && rm -rf /var/lib/apt/lists/*
# Match the app image's node user to access its owner-only admin socket.
USER 1000:1000
CMD ["socat", "TCP-LISTEN:8089,fork,reuseaddr", "UNIX-CONNECT:/run/tekiya-admin/admin.sock"]
