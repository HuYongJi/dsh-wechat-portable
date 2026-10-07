# Public synthetic TLS fixtures

The localhost certificate and private key in this directory are intentionally public, generated solely for local HTTPS regression servers. They are not user credentials and must never be used in deployment.

Both PEM files are tracked through two exact-path `.gitignore` exceptions; other PEM/key files remain ignored. The certificate is self-signed, has `CN=localhost` and only `DNS:localhost` as a SAN. Its SHA-256 certificate fingerprint is `0D:E7:74:04:95:C3:9F:DF:0A:DF:B4:F0:CC:CA:2B:39:28:EC:AC:38:4C:B1:77:A2:73:55:99:A7:1B:71:85:22`.

Tests trust this certificate only in a dedicated child process through NODE_EXTRA_CA_CERTS. No system trust store or production TLS setting is changed. Fixtures ship in the source archive, never in the plugin installation tarball. Running the tests requires Node only; OpenSSL was used once to create these fixtures, not by the test runner.
