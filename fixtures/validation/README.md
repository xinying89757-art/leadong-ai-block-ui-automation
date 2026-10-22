Small genuine image files used to verify rejection of unsupported formats:

- `tiny.gif`: GIF89a, 1×1.
- `tiny.bmp`: Windows BMP, 1×1, 24-bit RGB.

Neither file is a renamed text file. The valid PNG comes from `fixtures/images/test-image.png`. The >5 MiB PNG is generated at runtime by `src/validation-fixtures.mjs` under ignored `tmp/validation/<runId>/`; do not commit runtime images.
