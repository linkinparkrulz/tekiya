FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends tor \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/tor/nymdispenser \
    && chown -R debian-tor:debian-tor /var/lib/tor \
    && chmod 700 /var/lib/tor/nymdispenser
COPY torrc.container /etc/tor/torrc
USER debian-tor
CMD ["tor", "-f", "/etc/tor/torrc"]
