# Publishes the dashboard on the host's loopback while the app container
# stays on the internal network with no direct internet access.
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends socat \
    && rm -rf /var/lib/apt/lists/*
USER nobody
CMD ["socat", "TCP-LISTEN:8089,fork,reuseaddr", "TCP:app:8089"]
