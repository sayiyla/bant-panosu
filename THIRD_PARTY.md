# Third-party code

## 3d-force-graph 1.80.1 (`web/3d-force-graph.min.js`)

- Source: https://github.com/vasturiano/3d-force-graph (npm package `3d-force-graph@1.80.1`, `dist/3d-force-graph.min.js`, copied unmodified)
- SHA-256: `13088340aad408156064fd120c3bc3a47c93a3cc45b8f132d6284b20e2223be9`
- License: MIT. The bundle also contains compiled dependencies that are MIT licensed too: three.js, three-forcegraph, three-render-objects, kapsule, accessor-fn, d3-force-3d.
- Use: the Graph tab (`web/graph.js`). The file is only loaded when the Graph tab is opened.

```
MIT License

Copyright (c) 2017 Vasco Asturiano

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## yaml (npm, runtime dependency)

- https://github.com/eemeli/yaml, ISC license. Used to parse pipeline and agent files (`src/pipelines.ts`). It is installed with `npm install`, not copied into this repository.
