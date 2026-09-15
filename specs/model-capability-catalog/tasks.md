# Implementation Plan

- [x] 1. Define and validate provider-neutral exact-model capabilities.
  - Add the type to `dsh-llm` and export it from the public type surface.
  - Normalize and detach it in `LlmRuntime`.
  - Add focused service tests for valid, omitted, and invalid records.
  - _Requirement: 1_

- [x] 2. Declare capabilities in built-in adapters.
  - Add the direct DeepSeek declaration.
  - Add the pi-ai declaration based on the resolved pi-ai API and current
    adapter behavior.
  - Add adapter tests for Chat Completions and Responses routes.
  - _Requirement: 2_

- [x] 3. Project capabilities through the Host model catalog.
  - Extend `ModelCatalogModel` and the catalog builder.
  - Regenerate generated API artifacts when required by the repository gates.
  - Add Host catalog coverage.
  - _Requirement: 3_

- [x] 4. Update package documentation and record the engineering decision.
  - Document the meaning and current limitations in `dsh-llm` and adapter
    README files.
  - Add the required Agent Note.
  - Run focused typecheck, tests, and documentation checks.
  - _Requirement: 4_
