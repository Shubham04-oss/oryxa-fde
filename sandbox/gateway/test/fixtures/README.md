# Test fixtures

`sigv4-suite.json` holds the Signature Version 4 cases of AWS's signing test suite, from
[awslabs/aws-c-auth](https://github.com/awslabs/aws-c-auth/tree/main/tests/aws-signing-test-suite/v4), licensed under
the Apache License 2.0. For each case it keeps the context, the request, and the expected canonical request, string
to sign and signature, unchanged. The credentials in it are AWS's published example values (`AKIDEXAMPLE`).
