# Windows code signing

Public Windows releases should Authenticode-sign both the packaged desktop executable and the final Setup executable. A self-signed certificate does not establish public trust and does not solve SmartScreen warnings.

## Recommended service

[Microsoft Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/overview) is Microsoft's recommended signing service for applications distributed outside the Microsoft Store. It requires an Azure subscription and a verified public identity. Individual public-trust identities are currently available in the United States and Canada; supported organization regions are broader.

Microsoft currently lists the base service at approximately USD $10 per month. An OV certificate from a public certificate authority is an alternative. EV certificates no longer receive an automatic SmartScreen reputation bypass.

The [Microsoft Store](https://learn.microsoft.com/windows/apps/publish/) is the only distribution option that reliably avoids SmartScreen download warnings immediately because Store-distributed packages are signed by Microsoft. Directly downloaded, correctly signed executables can still show an initial reputation warning while the publisher and file build reputation.

## Azure setup

1. Follow Microsoft's [Artifact Signing quickstart](https://learn.microsoft.com/azure/artifact-signing/quickstart) to create an account, complete public identity validation, and create a **Public Trust** certificate profile.
2. Create a Microsoft Entra application or managed identity for GitHub Actions.
3. Add a federated credential restricted to this repository and its release workflow or release environment.
4. Grant that identity the **Artifact Signing Certificate Profile Signer** role on the certificate profile.
5. Add these GitHub Actions secrets:
   - `ARTIFACT_SIGNING_AZURE_CLIENT_ID`
   - `ARTIFACT_SIGNING_AZURE_TENANT_ID`
   - `ARTIFACT_SIGNING_AZURE_SUBSCRIPTION_ID`
6. Add these GitHub Actions variables:
   - `ARTIFACT_SIGNING_ENDPOINT`
   - `ARTIFACT_SIGNING_ACCOUNT_NAME`
   - `ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME`
   - `ARTIFACT_SIGNING_ENABLED` = `true`

The complete-release workflow then uses GitHub OIDC to authenticate, signs and timestamps `FoundryVTT MCP Bridge.exe`, builds Setup around that signed application, signs and timestamps the final Setup executable, and rejects the release job if either signature does not verify as `Valid`.

Keep `ARTIFACT_SIGNING_ENABLED` unset until identity validation, role assignment, and repository configuration are complete. Never store a certificate private key or Azure client secret in the repository.

## Reputation expectations

Use the same verified publisher identity for every release and never modify an executable after signing. Microsoft explains the current reputation behavior in [SmartScreen reputation for Windows app developers](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation) and compares the available certificates and services in [Code signing options for Windows app developers](https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options).
