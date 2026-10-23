# APIMatic project for the Open Aisle Merchant API

```
apimatic/
  src/
    APIMATIC-BUILD.json        portal + package settings (npm, PyPI, Maven names)
    spec/
      openapi.yaml             copy of apps/web/public/openapi.yaml (a test keeps them equal)
      APIMATIC-META.json       code-generation settings
```

Generate an SDK (needs a free APIMatic account key):

```bash
npx @apimatic/cli@1.5.0 auth login --auth-key=<your key>
npx @apimatic/cli@1.5.0 api validate --file=apimatic/src/spec/openapi.yaml
npx @apimatic/cli@1.5.0 sdk generate --language=typescript --input=apimatic --destination=apimatic/sdk/typescript
```

The workflow `.github/workflows/apimatic-sdks.yml` does this for TypeScript, Python and Java on every change, when the repository has an `APIMATIC_API_KEY` secret.

After changing the API, copy the spec: `cp apps/web/public/openapi.yaml apimatic/src/spec/openapi.yaml`.
