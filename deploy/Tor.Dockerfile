FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends tor \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/tor/nymdispenser /run/onion \
    && chown -R debian-tor:debian-tor /var/lib/tor /run/onion \
    && chmod 700 /var/lib/tor/nymdispenser
COPY torrc.container /etc/tor/torrc
COPY tor-start.sh /usr/local/bin/tor-start
RUN chmod 755 /usr/local/bin/tor-start
USER debian-tor
CMD ["/usr/local/bin/tor-start"]
