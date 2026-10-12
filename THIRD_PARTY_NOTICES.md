# Third-party notices

The fingerprint probes, reference bank and scoring code in `vendor/modeltrace/`
are derived from [xqy2006/ModelTrace](https://github.com/xqy2006/ModelTrace).
Their original license is retained at `vendor/modeltrace/LICENSE`, and the
source revision and local adaptations are recorded in
`vendor/modeltrace/provenance.json`.

Runtime dependencies `jose` and `ws`, and the optional packaged Codex CLI,
retain their respective upstream licenses. Their versions are pinned by the
lockfile or Docker build argument. No account tokens or runtime data are part
of the source repository or image.
