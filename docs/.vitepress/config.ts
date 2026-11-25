import { defineConfig } from 'vitepress';

const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
const base = process.env.DOCS_BASE ?? (process.env.GITHUB_ACTIONS && repo ? `/${repo}/` : '/');

export default defineConfig({
  title: 'Substratum',
  description: 'A reactive spatial runtime for composable systems.',
  base,
  cleanUrls: true,
  lastUpdated: true,

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Extensions', link: '/extensions/' },
      { text: 'Live Demo', link: '/demos/commons' },
      { text: 'API', link: '/api/' },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/SvalTek/substratum' },
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Core Concepts', link: '/guide/core-concepts' },
          { text: 'Spatial Model', link: '/guide/spatial-model' },
          { text: 'Querying', link: '/guide/querying' },
          { text: 'Reactivity & Events', link: '/guide/reactivity' },
          { text: 'Middleware & Plugins', link: '/guide/middleware-and-plugins' },
          { text: 'Transactions', link: '/guide/transactions' },
          { text: 'Architecture & Limits', link: '/guide/architecture' },
        ],
      },
      {
        text: 'Computational Extensions',
        items: [
          { text: 'Overview', link: '/extensions/' },
          { text: 'Math Primitives', link: '/extensions/math' },
          { text: 'Attention & Scoring', link: '/extensions/attention' },
          { text: 'Statistics & Info Theory', link: '/extensions/statistics' },
          { text: 'Density Clustering', link: '/extensions/clustering' },
          { text: 'Adaptive Associations', link: '/extensions/associations' },
          { text: 'Self-Organising Maps', link: '/extensions/som' },
          { text: 'Activation Propagation', link: '/extensions/propagation' },
        ],
      },
      {
        text: 'Interactive Demos',
        items: [
          { text: 'Commons Lab', link: '/demos/commons' },
        ],
      },
      {
        text: 'API Reference',
        items: [
          { text: 'Overview & Constructor', link: '/api/' },
          { text: 'Content & Cells', link: '/api/content-and-cells' },
          { text: 'Queries & Geometry', link: '/api/queries-and-geometry' },
          { text: 'Events, Middleware & Plugins', link: '/api/events-and-plugins' },
        ],
      },
    ],

    search: {
      provider: 'local',
    },

    outline: {
      level: [2, 3],
    },

    footer: {
      message: 'Substratum — A reactive spatial runtime for composable systems.',
    },
  },
});
