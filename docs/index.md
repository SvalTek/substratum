---
layout: home

hero:
  name: Substratum
  text: A reactive spatial runtime for composable systems.
  tagline: Store typed shared content across positions or regions, query by space or semantics, and let independent plugins enforce rules and react through one transactional spatial context.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: API Reference
      link: /api/
    - theme: alt
      text: Architecture
      link: /guide/architecture

features:
  - title: Region-First Spatial Model
    details: Query, subscribe, and emit using canonical cell addresses, inclusive integer Bounds, or point + extent BoxRegions — without manual prefix boilerplate.
  - title: Branded, Narrowed TypeScript
    details: Content IDs are branded by kind. Kind-scoped queries, middleware patches, and spatial:change transitions narrow automatically at compile time.
  - title: Transactional Middleware
    details: Intercept, transform, or veto content, attachment, and cell mutations synchronously. Nested batch() savepoints roll back internal state atomically.
  - title: Scoped Reactive Events
    details: Subscribe globally or to any Region. Shared payload updates route through the placement index, with lazy per-content transitions on spatial:change.
  - title: Dual-Index Query Planner
    details: Independent 1D axis postings avoid cubic 3D query blowup, while a numeric radix-27 proximity index and sparse semantic short-circuits keep queries fast.
  - title: Zero Runtime Dependencies
    details: Standard ES2022 TypeScript running cleanly across Bun, Node.js 20+, Deno, and browsers as compiled ESM or a single-file ESM bundle.
---
