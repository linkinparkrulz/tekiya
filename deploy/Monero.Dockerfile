# View-only monero-wallet-rpc for Tekiya's optional Monero payments.
#
# The release is verified, not trusted: the signed hashes.txt must verify
# against binaryFate's release-signing key (fingerprint pinned below), and
# the downloaded archive must match its SHA-256 there. Set MONERO_SHA256
# (with MONERO_VERSION) to pin an exact build instead.
FROM debian:bookworm-slim
ARG MONERO_VERSION=""
ARG MONERO_SHA256=""
ARG SIGNING_KEY_FINGERPRINT=81AC591FE9C4B65C5806AFC3F0AF4D462A0BDF92
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl gnupg bzip2 \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x64 ;; arm64) arch=armv8 ;; \
      *) echo "Unsupported architecture" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    curl -fsSLo hashes.txt https://www.getmonero.org/downloads/hashes.txt; \
    curl -fsSLo binaryfate.asc \
      https://raw.githubusercontent.com/monero-project/monero/master/utils/gpg_keys/binaryfate.asc; \
    export GNUPGHOME="$(mktemp -d)"; \
    gpg --batch --import binaryfate.asc; \
    gpg --batch --with-colons --fingerprint \
      | grep -q "^fpr:::::::::${SIGNING_KEY_FINGERPRINT}:"; \
    gpg --batch --verify hashes.txt; \
    if [ -n "$MONERO_VERSION" ]; then \
      file="monero-linux-${arch}-v${MONERO_VERSION}.tar.bz2"; \
    else \
      file="$(grep -o "monero-linux-${arch}-v[0-9.]*\.tar\.bz2" hashes.txt | head -n1)"; \
    fi; \
    expected="${MONERO_SHA256:-$(grep " *${file}\$" hashes.txt | awk '{print $1}')}"; \
    [ -n "$expected" ] || { echo "No hash for ${file}" >&2; exit 1; }; \
    curl -fsSLo monero.tar.bz2 "https://downloads.getmonero.org/cli/${file}"; \
    echo "${expected}  monero.tar.bz2" | sha256sum -c -; \
    tar -xjf monero.tar.bz2; \
    install -m 0755 monero-*/monero-wallet-rpc /usr/local/bin/; \
    rm -rf /tmp/* "$GNUPGHOME"
# Same uid as the app's node user, so it can read the RPC login file.
RUN useradd --uid 1000 --create-home monero \
    && mkdir -p /wallet /monero-secret \
    && chown monero:monero /wallet /monero-secret
COPY monero-start.sh /usr/local/bin/monero-start
RUN chmod 755 /usr/local/bin/monero-start
USER monero
CMD ["/usr/local/bin/monero-start"]
