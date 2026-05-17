# Companion Product Map

This entry map groups companion behavior contracts and public product framing.

```mermaid
flowchart TD
  product["Companion Product"]
  core["Friend Core KB"]
  autonomy["Companion Autonomy"]
  direction["Product Direction"]

  product --> core
  product --> autonomy
  product --> direction
  core -. "reader context" .-> autonomy
  core -. "reader context" .-> direction
```

## Child Maps

- [Friend Core KB](./core-map.md)
- [Companion Autonomy](./companion-autonomy/companion-autonomy-map.md)
- [Product Direction](./product-direction/product-direction-map.md)
