# Public synthetic TLS fixtures

The localhost certificate and private key in this directory are intentionally public, generated solely for local HTTPS regression servers. They are not user credentials and must never be used in deployment.

Tests trust this certificate only in a dedicated child process through NODE_EXTRA_CA_CERTS. No system trust store or production TLS setting is changed. Fixtures ship in the source archive, never in the plugin installation tarball. Running the tests requires Node only; OpenSSL was used once to create these fixtures, not by the test runner.
