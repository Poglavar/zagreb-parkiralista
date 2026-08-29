# Tables used by this repo

Synced from prod with `sync-tables` (single prod DB "geodata" on `do`).
Since 2026-08-27 city-scale batches run on valhalla and write STRAIGHT TO PROD
(see MEMORY.md), so prod is the authority for parking runs — run `sync-tables`
here to catch the laptop up after a batch.

## parking schema (this repo's domain)

- parking.run
- parking.observation
- parking.verdict
- parking.segment
- parking.segment_coverage
- parking.segment_imagery
- parking.road_segment_mo
- parking.osm_parking
- parking.aerial_candidate
- parking.area (local-only) — retired 2026-07-14, kept for history
- parking.area_boundary
- parking.current_state (local-only) — VIEW, derived from synced tables
- parking.segment_status (local-only) — VIEW, derived from synced tables

## shared tables read by the pipeline (owned by cadastre-data / zagreb-ulice)

- public.road_width_segment
- public.osm_road (schema-only) — big; the laptop copy is maintained by its own ingest
- ppv.boundary_jms
