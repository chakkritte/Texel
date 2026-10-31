# Compile runtime only: full TeX Live from the already-present local image.
# This container is spawned per compile job with no network, read-only rootfs,
# dropped capabilities and a 120s timeout. Entrypoint is cleared so the worker
# can run `/bin/sh -lc` directly.
FROM overleaf-latex-full:6.3.2

USER root
ENTRYPOINT []
CMD ["/bin/sh", "-lc", "sleep infinity"]
