# zagreb-parkiralista

Otvorena baza parkirališta u Zagrebu — službenih, neslužbenih i procijenjenih kapaciteta — izvedena iz OpenStreetMapa, službenog ortofota i strojnog vida.

Open database of parking areas in Zagreb — official, informal, and capacity-estimated — derived from OpenStreetMap, official orthophoto, and computer vision segmentation.

## Sadržaj / Contents

- [Trenutno stanje](#trenutno-stanje) — što je gotovo, što je blokirano
- [Ključni nalazi](#ključni-nalazi) — što smo naučili o parkiralištima u Zagrebu
- [Cilj](#cilj)
- [Faze](#faze)
- [Izvori slika](#izvori-slika)
- [Repository struktura](#repository-struktura)
- [Quick start](#quick-start)
- [Reference](#reference)

## Trenutno stanje

Snapshot: travanj 2026.

| Faza | Status | Bilješka |
|---|---|---|
| **0 — OSM baseline** | shipped | 4.898 features (4.777 poligona + 121 nodes), regenerirano s `parking_kind` klasifikacijom |
| **1.1 — Tile fetcher** | shipped | Verificirano protiv City of Zagreb CDOF 2022 endpoint-a |
| **1.2 — SAM 3 segmentacija** | blokirano | `facebook/sam3` čeka HF gating review; LangSAM fallback nepristupačan zbog `transformers 5.5` ↔ `groundingdino-py 0.4.0` inkompatibilnosti |
| **1.3–1.4 — Vectorize + diff vs OSM** | scaffolded | Skripte spremne, čekaju Fazu 1.2 |
| **2 — Capacity refinement** | shipped | Spaja OSM + ML kandidate u jedinstveni `parking_with_capacity.geojson` |
| **3.1 — Vehicle detection (YOLO)** | shipped | Ultralytics YOLO; za produkciju treba CARPK fine-tuning |
| **3.2 — Informal classification** | shipped | Vehicle ↔ official parking diff + landuse-based klasifikacija u 14 kategorija |
| **4 — Web preglednik** | shipped | Leaflet + admin level dropdown + headline statistike + per-area tablica + tile preview u popup-u |
| **5 — LLM cartographer** | shipped + validated | 17 composites generirano i procesirano; **96 Claude prijedloga + 4 GPT-5 prijedloga = 100 ukupno**. Podrška za oba providera (`--provider anthropic\|openai\|both`) u `31_llm_propose.py`. Output u `data/candidates/llm_parking_candidates.geojson`, render u viewer-u s teal (Claude) i magenta (GPT) bojama. |
| **6 — Street View + LLM** | POC shipped | Self-contained Node.js sub-project u `street-view/`. Dohvaća Google Street View Static API frame-ove po segmentu ulice, šalje ih OpenAI GPT-5.4 vision API-ju za semantičku klasifikaciju (parkira li se ovdje? lijevo/desno? formalno/neformalno?), generira curb-strip parking polygone, i sadrži statički review UI (`review.html`) za ljudsku provjeru. Komplementaran s Fazom 5 (Faza 5 gleda odozgo, Faza 6 popreko). |
| **API** — `/api/borders` | shipped | Dodano u shared `cadastre-data/api` (`domains/borders/`), izlaže administrativne-division granice (gradske četvrti / naselja / mjesni odbori) iz `city_border` PostGIS tablice. Naziv `borders` umjesto `admin` jer je riječ o administrativnim *podjelama*, ne autentifikaciji. |

### Ključne brojke (verificirano iz aktualnih datoteka)

**Faza 0 — OSM baseline** (`data/osm/parking_zagreb.geojson`):
- **4.898** parking features ukupno (4.777 polygon ways/relations + 121 point nodes)
- 4.798 open-air + 100 enclosed
- **163.731** procijenjenih parking mjesta (148.224 otvorenih + 15.507 zatvorenih)
- **3,91 km²** ukupne otvorene parking površine
- 365 features (~7,5%) ima OSM `capacity` tag — preostalih ~92% iz `area / 25 m²` heuristike

**Faza 3 — vehicle detection + informal classification** (full 1.260-tile corpus):
- **5.783** YOLO detekcija vozila (5.068 cars + 587 trucks + 127 buses + 1 motorcycle), svi prošli `--require-plausible-size` filter
- **1.619 unutar službenih parkinga (28%)**, **4.164 neslužbenih (72%)**
- Per-type breakdown (`data/final/informal_parking.geojson` → `informal_by_type`):
  - 1.918 uz cestu / nepoznato
  - 1.563 stambeno dvorište
  - 310 trgovačko područje
  - **89 bolnica grounds**
  - **60 škola grounds**
  - 56 park / igralište
  - 56 zelena površina
  - 48 trg
  - 30 industrijsko dvorište
  - 17 šuma
  - 12 javna zgrada (civic)
  - 5 gradilište

**Faza 5 — LLM cartographer** (17 composites, 4×4 grid):
- **100 LLM kandidati ukupno** (`data/candidates/llm_parking_candidates.geojson`)
- 96 od Claude Sonnet 4.6 (17 composites @ ~5,65 prosjek, $0,29 ukupno)
- 4 od GPT-5 (4 composites @ ~1,0 prosjek, $0,17 ukupno)
- By kind: 42 street_parking · 39 lot · 19 courtyard
- By confidence: 23 high · 66 medium · 11 low

**OSM context layers**:
- **39.303** OSM landuse poligona u 14 kategorija (`data/osm/landuse_zagreb.geojson`, 27 MB)
- **90.316** OSM highway features (`data/osm/highways_zagreb.geojson`, 40 MB)

**Administrativne razine** (iz shared `cadastre-data/api` + `city_border` tablice):
- 17 / 68 / 248 jedinica na razinama 1 / 2 / 3 (Gradske četvrti / Naselja / Mjesni odbori)

### Tekući korpus za ML obradu

- **1.260 tile-ova** (1024×1024 px @ 0,15 m/px), **1.260 JPEG previews** za viewer popup
- Centralni Zagreb bbox 15,94–16,02 / 45,79–45,83 (~6 km × 4,5 km)
- ~3 GB GeoTIFF + ~110 MB JPEG na disku (oba gitignored)
- 17 composite-a (768 m × 768 m svaki) generirano za Fazu 5

## Ključni nalazi

Svaki nalaz koji je promijenio kako razmišljamo o projektu, redom kojim je otkriven.

### 1. OSM već ima poligone — kapacitet je prazna pretinac

OSM ima ~3.800 `amenity=parking` poligona u Zagrebu (sada s nodama 4.898 features), ali samo ~7% ima `capacity=*` tag. **Posao Faze 1 nije izvlačiti poligone, već popunjavati kapacitet** za ~92% poligona koji nemaju tagiranu vrijednost. Phase 0 to već radi heuristikom; refined estimate iz line/car detection (Faza 2 v2) bit će sljedeći skok.

### 2. Enclosed parking je neviđen iz zraka

100 features klasificirano kao zatvoreno (`parking_kind=enclosed`) ima ~15.500 mjesta — otprilike 9,5% ukupnog kapaciteta. Većina su node-only OSM zapisi (npr. **Garaža Cvjetni trg, 292 mjesta**, mapirana kao jedna točka jer nema površinski footprint). ML pipeline iz zraka NE može pronaći ove garaže — moraju doći iz OSM-a ili ručnog unosa. Stoga viewer ima dva odvojena layer toggle-a: "Otvorena (OSM)" i "Zatvorena (OSM)" — različita boja i ikona.

### 3. Rezolucija određuje što je moguće

| GSD | Lot polygons | Stall lines | Cars (occupancy) |
|---|---|---|---|
| **0,5 m** (DGU DOF5) | da (~70–85 IoU) | **ne** (sub-pixel linije) | marginalno |
| **0,3 m** | da | ne | da |
| **0,10–0,15 m** (City CDOF, drone) | da | da (Hough na top-hat) | da |

City of Zagreb CDOF 2022 (~0,10–0,15 m) je pravi izvor za ovaj projekt. DGU DOF5 0,5 m je dovoljan za detekciju velikih parkirnih ploha, ali ne i za brojanje pojedinačnih mjesta.

### 4. SAM 3 + samgeo na Mac-u: dva blokera

- **Gating**: `facebook/sam3` je HuggingFace gated repo s manualnim review-om (Meta odobrava). Token mora biti u `.env` kao `HF_API_KEY` — script `02_segment.py` ga premosti u `HF_TOKEN`.
- **Mac backend**: `samgeo.SamGeo3(backend="meta")` traži NVIDIA Triton/CUDA i ne radi na Apple Silicon. Mora se koristiti `backend="transformers"` koji ide kroz HF transformers (sporije, ali radi na MPS).
- **LangSAM fallback je trenutno slomljen**: `transformers 5.5` izbacio je `BertModel.get_head_mask` koji `groundingdino-py 0.4.0` još uvijek poziva → `AttributeError`. Fix bi tražio drugi venv pinned na `transformers<5.0`.

Detalji u `~/.claude/projects/-Users-simun-Code-zagreb-parkiralista/memory/sam3_langsam_blockers.md`.

### 5. YOLO COCO radi na aerial — ali kao placeholder

`ultralytics yolov8n.pt` (default model, COCO weights) detektira vozila iz CDOF 2022 imagery-a u **0,16 sekundi po tile-u** na MacBook M-series MPS. Nije gated — težine se skidaju s GitHub releases-a. Ali trenirano je na ground-level fotografijama, pa za top-down treba `--conf 0.05` (umjesto 0,25 default-a) i daje 5–10× više false positive detekcija nego CARPK-fine-tuned model. **`--require-plausible-size` filter** baca detekcije čije bbox dimenzije nisu ~ realistične auto-veličine (2,5–8 m × 1–4 m), čime se podiže precision sa ~14% na ~95%.

Za produkciju: fine-tunirati YOLOv11 na CARPK datasetu (drone-captured top-down vehicles, ~0,1 m GSD).

### 6. Većina parkiranja u centralnom Zagrebu je "uz cestu" — full corpus rezultat

Nakon obrade **svih 1.260 tile-ova** centralnog Zagreba (Trešnjevka, Trnje, Donji Grad, dijelovi Maksimira): YOLO je pronašao **5.783 vozila**, od kojih su **1.619 (28%) unutar postojećih `amenity=parking` poligona**, a **4.164 (72%) izvan njih**. Klasifikacija po landuse:

| Lokacija | Count | Što znači |
|---|---|---|
| Uz cestu / nepoznato | **1.918** | OSM ne mapira street parking kao poligone, već kao `parking:lane=*` na ulici — ovo je poznata struktura |
| Stambeno dvorište (residential block) | **1.563** | Cars u stambenim dvorištima — često neformalno ali tolerirano |
| Trgovačko područje | 310 | Tržni centri, robne kuće |
| **Bolnica (hospital grounds)** | **89** | Vozila parkirana na bolničkom zemljištu — eyeball-verifiable |
| **Škola (school grounds)** | **60** | Vozila na školskom zemljištu — često problematično |
| Park / igralište | 56 | Stvarni parkovi |
| Zelena površina | 56 | Travnjaci |
| Trg | 48 | Trg N. Š. Zrinskog, Trg bana Jelačića itd. |
| Industrijsko dvorište | 30 | Industrijski kompleksi |
| Šuma | 17 | False positives ili parkiranje u izletištima |
| Civic (javne zgrade) | 12 | Sudovi, vatrogasci, policija |
| Gradilište | 5 | Construction sites |

**Posebno korisno**: 89 vozila na bolničkim i 60 na školskim grounds su lake za eyeball-verification kroz viewer popup (svaki klik prikazuje 256×256 isječak source tile-a s crvenim bbox-om oko detekcije) i mogu se direktno akcionirati.

### 7. Variable name collision je opasan u dugim Python skriptama

`20_detect_informal.py` je prvi put silently dao 100% `roadside_or_unknown` jer sam nazvao `parts` listu i za official parking i za landuse — drugi je tiho overwriteao prvu, a defensive bounds check eat-ao je svaki rezultat. Diagnostic je bio da je standalone replikacija točno radila, a script nije. Memory: `feedback_variable_collisions.md`.

### 8. Claude Sonnet 4.6 dramatično nadmašuje GPT-5 za visual cartography (Faza 5)

A/B test na identičnim composite-ima (17 za Claude, 4 za GPT-5):

| | Claude Sonnet 4.6 | GPT-5 |
|---|---|---|
| Prosj. prijedloga po pozivu | **5,65** | 1,0 |
| Composites s **0** prijedloga | 0 / 17 | 2 / 4 |
| Latencija | ~12 s | ~67 s |
| Cijena po pozivu | **~$0,017** | ~$0,043 |
| Reasoning tokens | 0 | 2.624–6.400 per call |
| Confidence levels | high · medium · low | only medium |
| Kategorije | lot · street_parking · courtyard | only street_parking |

**Konkretan slučaj**: na istom composite-u gdje je Claude predložio 7 kandidata (uključujući "tree-canopy" edge case s low confidence), GPT-5 je predložio 0 ("remaining red-dot clusters are on roadways or ambiguous courtyards without clear pavement evidence"). GPT-5 je potrošio 97,7 sekundi i 6.400 reasoning tokens da dođe do tog zaključka.

**Zašto**: GPT-5 troši 90–95% completion budget-a na hidden reasoning, pa commits samo na najevidence-rigorous prijedloge — odlično za high-precision filtriranje, loše za "find me everything worth a glance." GPT-4o je još lošiji za ovaj task: 22 tokena outputa, "no clear unmapped parking areas identified" u 3,6 s.

**Praktičan zaključak**:
- **Default model za Fazu 5: Claude Sonnet 4.6**. ~17× više kandidata po dolaru.
- GPT-5 se može koristiti kao high-precision second-opinion filter (whittle Claude's 96 down to "definitely look at these N").
- GPT-5 zahtijeva `--max-tokens 10000` zbog hidden reasoning overhead-a; manje od toga vraća prazan response.
- GPT-4o nije kandidat za ovaj task pri trenutnom prompt-u.

Detalji: `~/.claude/projects/-Users-simun-Code-zagreb-parkiralista/memory/llm_vision_choice_april_2026.md`

## Cilj

Napraviti najpotpuniju javno dostupnu kartu parkirališta u Zagrebu, uključujući:

1. **Službena parkirališta** koja postoje u OSM-u (već dobro pokrivena)
2. **Službena parkirališta koja nedostaju u OSM-u** (otkrivena strojnim vidom iz ortofota — Faza 1)
3. **Procijenjeni kapacitet** za sva parkirališta (broj mjesta — Faza 2)
4. **Neslužbena ("de facto") parkirališta** — automobili parkirani na nogostupima, dvorištima, parcelama, zelenim površinama, neiskorištenim trakama itd. (Faza 3)
5. **Web preglednik** koji prikazuje sve slojeve s admin-level breakdown-om (Faza 4)
6. **LLM cartographer** koji čita rendered map composite-e i predlaže neviđene parkinge na temelju vizualne i kontekstualne evidencije (Faza 5)
7. **Street-level klasifikacija** — Google Street View frame-ovi po segmentu ulice, klasificirani vision LLM-om, s human review loop-om (Faza 6)

## Faze

### Faza 0: OSM baseline — shipped

Skinuti `amenity=parking` nodes/ways/relations za Zagreb iz Overpass API-ja, izračunati površine u m² (projekcija EPSG:3765), klasificirati po `parking_kind` (open_air vs enclosed), procijeniti kapacitet po formuli `area / 25 m²` za sve poligone bez `capacity` taga. Spremiti kao `data/osm/parking_zagreb.geojson`.

**Output**: GeoJSON FeatureCollection s 4.898 features. Koristan i sam za sebe; nužan kao baseline za Fazu 1 (set-difference).

**Skripta**: `pipeline/00_fetch_osm.py`

### Faza 1: Pronaći službena parkirališta koja nedostaju u OSM-u — blokirano (SAM 3 gating)

1. Tile-ati Zagreb bbox u 1024×1024 GeoTIFF-ove iz CDOF 2022 (`pipeline/01_fetch_tiles.py`) — shipped
2. Pokrenuti SAM 3 (HuggingFace transformers backend) s text promptom `"parking lot"` (`pipeline/02_segment.py`) — **čeka HF access review za `facebook/sam3`**
3. Mask → poligoni s filterima i regularizacijom (`pipeline/03_vectorize.py`) — scaffolded
4. Set-difference protiv OSM baseline koristeći IoU prag (`pipeline/04_diff_osm.py`) — scaffolded

**Output (kad SAM 3 unblock)**: `data/candidates/missing_parking.geojson` + `data/candidates/overlapping_parking.geojson`

### Faza 2: Capacity refinement — shipped (v1)

Spaja OSM baseline s Faza 1 ML kandidatima u jedinstveni `data/final/parking_with_capacity.geojson` s `capacity_final` i `capacity_method` poljem. Koristi area-based heuristiku po default-u; v2 će dodati refined estimate iz car/stall detekcije.

**Skripta**: `pipeline/10_refine_capacity.py`

### Faza 3: Neslužbena ("de facto") parkirališta — shipped

1. **Vehicle detection** — Ultralytics YOLO nad tile dirom; ekstrahira vozila kao Point GeoJSON s georeferenciranim koordinatama, real-world bbox dimenzijama i plausibility flag-om (`pipeline/11_detect_vehicles.py`)
2. **Landuse fetch** — jedan-shot Overpass query za sve relevantne `landuse=*`, `leisure=*`, `natural=*`, `amenity=*` poligone u Zagrebu, klasificiranih u 14 kategorija (`pipeline/21_fetch_landuse.py`)
3. **Informal classification** — vozila izvan svih službenih parkirnih poligona (bufferiranih za 5 m) → neslužbena. Svako se klasificira po landuse intersection-u (`pipeline/20_detect_informal.py`)

**Output**: `data/final/informal_parking.geojson` — Point features, color-coded u viewer-u po `informal_type`.

**Napomena**: Trenutni YOLO koristi COCO weights (placeholder). Za produkciju, fine-tunirati YOLOv11-seg na CARPK datasetu.

### Faza 5: LLM cartographer — shipped + validated

Multimodal LLM kao "kartograf koji čita karte". Razlika prema Fazi 1 (SAM 3) i Fazi 3 (YOLO):
te su pixel-level perceptual modeli — vide samo što je doslovno na slici. Faza 5
je *reasoning* model — vidi sliku PLUS postojeće OSM mapiranje PLUS detektirana vozila,
i može deducirati gdje vjerojatno postoji parking koji nije mapiran (npr. ulica
s krošnjama gdje se vidi par auta i susjedni segmenti imaju mapirano parkiranje).

**Pipeline:**

1. **Stitch** — `pipeline/22_fetch_highways.py` (jednom) skida OSM highway network (90.316 features), zatim `pipeline/30_render_composite.py` spaja N×N CDOF tile-ova u jednu kvadratnu sliku (default `--grid 3` = 3×3, primjeri u repo-u koriste `--grid 4` = 768 m × 768 m @ 1024×1024 px)
2. **Overlay** — na sliku se crtaju OSM ceste (žute/bijele linije, vidljive čak i ispod krošnji), postojeći parking poligoni (plavo s debelim borderom), garažni nodovi (purple "P" pin), YOLO vozila (mali crveni dotovi), legenda u kutu
3. **Reason** — `pipeline/31_llm_propose.py` šalje composite PNG vision LLM-u (`--provider anthropic` default, `--provider openai` ili `--provider both`) s prompt-om "pronađi vjerojatne neviđene parkinge". LLM vraća strukturirani JSON s prijedlozima (tip, pouzdanost, razlog, bbox_pct u image-space koordinatama 0..1)
4. **Georeference** — bbox_pct se mapira preko composite metadata sidecar-a (`composite_*.json`) na WGS84 polygon
5. **Render** — viewer ima dva sub-toggle-a: "Claude" (teal, dashed border, `swatch-llm-anthropic`) i "GPT" (magenta, dashed border, `swatch-llm-openai`). Klik na poligon → popup s `kind`, `confidence`, LLM razlogom + source composite

**Setup**: Treba ili `ANTHROPIC_API_KEY` ili `OPENAI_API_KEY` u root `.env` (ili oba za A/B). Skripte čitaju `.env` automatski, nije potreban `huggingface-cli login` ni nikakav drugi shell setup.

**Provider podrška**:
- **anthropic** (default) → Claude Sonnet 4.6, max_tokens 2000 (sasvim dovoljno)
- **openai** → GPT-4o (default) ili GPT-5 (`--model gpt-5 --max-tokens 10000` zbog hidden reasoning tokens — manje od toga vraća prazan response)
- **both** → procesira oba providera u jednom run-u, output u istu datoteku s `provider` propertom po feature-u

**Stvarni troškovi (verificirano iz dosadašnjih runova)**:
- Claude Sonnet 4.6: ~$0,017 po composite-u (12 s, 687 output tokens)
- GPT-5: ~$0,043 po composite-u (67 s, 4.180 completion tokens uglavnom hidden reasoning)
- 17 composites pokrivenih za Zagreb central: ~$0,29 (Claude) ili ~$0,73 (GPT-5)

**Stvarni rezultati (full run, 17 composites)**:
- **96 Claude prijedloga** (5,65 prosjek po composite-u, 23 high-conf, 62 medium, 11 low)
- **4 GPT-5 prijedloga** (1,0 prosjek po composite-u, sve medium-conf, samo street_parking kategorija)
- **Zaključak**: Claude je default izbor za ovaj task (vidi Ključni nalaz #8 + memory `llm_vision_choice_april_2026.md`)

**Output**: `data/candidates/llm_parking_candidates.geojson` — Polygon features s `kind` (lot/street_parking/courtyard), `confidence` (high/medium/low), `reason` (LLM-ov razlog), `source_composite`, `provider`, `model` propertima. **Tretira se kao prijedlozi za ljudsku reviziju**, ne autoritativna mapa.

**Komplementarno s Fazom 6**: Faza 5 gleda odozgo (spatial layout), Faza 6 (street-view) gleda popreko (na razini ulice).

### Faza 6: Street View + LLM — POC shipped (`street-view/`)

Self-contained Node.js sub-project u `street-view/` direktoriju. Implementira segment-level curbside parking detection iz Google Street View frame-ova, klasificirane vision LLM-om. Komplementarno Fazi 5 jer street-level imagery vidi stvari koje aerial ne vidi: parking znakove, vertikalne markere, parking-lane linije ispod auta, ograde, koji segment ima parking na koju stranu.

**Pipeline** (sve skripte u `street-view/scripts/`):

1. **Import segments** — `import-road-width-demo.mjs` ili `import-road-width-selection.mjs` uvoze trimmed road segmente iz `zagreb-road-widths` repo-a (s width metadata)
2. **Prepare candidates** — `prepare-candidates.mjs` izvodi capture stations + headings + preview curb-strip polygons po segmentu
3. **Free metadata preflight** — `fetch-street-view-metadata.mjs` provjerava koji capture-ovi imaju Street View pokrivenost (Google metadata API je besplatan, ne troši kvotu)
4. **Image capture** — `fetch-street-view-images.mjs` skida samo metadata-validne slike kroz Google Street View Static API ($7/1000 panorama, prvih 10k mjesečno besplatno)
5. **Vision classification** — `analyze-openai.mjs` šalje frame-ove OpenAI GPT-5.4 vision API-ju s strukturiranim prompt-om: parkira li se ovdje? lijevo/desno? formalno/neformalno? na nogostupu ili u razini ceste? Logira billing summary po pozivu.
6. **Build polygons** — `build-parking-areas.mjs` konvertira AI klasifikacije u curb-strip parking polygone po segmentu
7. **Build review bundle** — `build-review-bundle.mjs` priprema offline JSON bundle za human review UI
8. **Static review UI** — `review.html` + `review.css` + `review.js` čitaju bundle, prikazuju image + AI conclusion + parking polygon side-by-side, dopuštaju human da klikne "agree" / "disagree" / override; storage je `localStorage` s eksportom u JSON
9. **Override loop** — exportirane override JSON datoteke se mogu vratiti u `build-parking-areas.mjs --overrides` za regen polygone

**Tehnologija**: Node.js (ESM), no build step. Vlastiti `package.json`. Test suite u `street-view/test/`.

**Setup**:

```sh
cd street-view
npm install
# API ključevi idu u root .env (ne u street-view/.env):
#   GOOGLE_MAPS_API_KEY=...
#   OPENAI_API_KEY=...
```

**Pokretanje za novo područje** — `process-area.mjs` je orchestrator koji chain-a sve korake:

```sh
set -a && source ../.env && set +a

# Pokreni cijeli pipeline za jedno područje (npr. "Trnje")
# Svaki korak koji ima gotov output se preskače (idempotentno).
node scripts/process-area.mjs --area "Trnje"

# Ili samo jedan korak:
node scripts/process-area.mjs --area "Trnje" --step import   # samo download batch rezultata
node scripts/process-area.mjs --area "Trnje" --step ingest --write  # upis u bazu

# Provjera statusa batcheva:
npm run batch:status
```

Koraci koje orchestrator izvodi redom (svaki se skip-a ako output postoji):
1. `selection` — generira segment selekciju iz zagreb-road-widths podataka
2. `candidates` — priprema capture stations + headings
3. `metadata` — preflight (besplatan Google API poziv)
4. `images` — skidanje slika ($7/1000, prvih 10k/mj besplatno)
5. `batch-jsonl` — generira OpenAI batch JSONL
6. `submit` — šalje batch (chunked, `--max-chunks N` za kontrolu troškova)
7. `import` — skida gotove batch rezultate i parsira ih
8. `ingest` — upisuje u PostGIS (dry-run po default-u, `--write` za produkciju)

**Quick offline demo** (bez API poziva):
```sh
npm run mock:run
npm run serve   # http://localhost:8015/review.html
```

**Cost model** (iz street-view/README.md):
- Google Street View Static API: $7/1000 panorama, 10k panorama free per month per SKU, metadata pre-flight je besplatan
- OpenAI GPT-5.4: ~$2.50/1M input + $15/1M output, batch API saves 50%
- Production flow: metadata preflight → fetch only valid images → AI run → only uncertain cases idu u human review

**Output**: `street-view/out/parking-areas.geojson` (curb-strip polygons), `street-view/out/openai-analyses.json` (AI classifications per capture), `street-view/out/review-bundle.json` (UI bundle).

**Limit za sad**: ovo je POC, nije integrirano u glavni viewer. Output GeoJSON može se ručno pregledati u QGIS-u ili kroz vlastiti `street-view/review.html`. Sljedeći korak: integrirati `parking-areas.geojson` u glavni viewer kao "Faza 6: Street View kandidati" layer.

Detalji: `street-view/README.md`.

### Faza 4: Web preglednik — shipped

Jednostavni HTML/CSS/JS preglednik (Leaflet.js + OSM base layer) koji prikazuje sve slojeve s mogućnošću uključivanja/isključivanja:

- **Otvorena (OSM)** — Faza 0 open-air poligoni, color-coded by capacity
- **Zatvorena (OSM)** — Faza 0 enclosed garages, dashed-purple poligoni + "P" pin marker za nodes
- **ML-otkrivena (Faza 1)** — placeholder layer, automatski se aktivira kad `data/candidates/missing_parking.geojson` postoji
- **Neslužbena (Faza 3)** — color-coded točke po `informal_type`, breakdown panel s brojem po kategoriji

Dodatne komponente:
- **Headline statistika**: ukupno parking mjesta (s otvoreno/zatvoreno sub-line), broj parkirališta, ukupna km² površina
- **Admin level dropdown**: Cijeli grad / Gradske četvrti / Naselja / Mjesni odbori — borders dohvaćeni iz `/api/borders` endpoint-a u shared cadastre-data API-ju (`domains/borders/`)
- **Per-area tablica**: za odabranu admin razinu, sortable lista po kapacitetu / broju parkirališta / površini / imenu, s otvoreno/zatvoreno breakdown-om
- **Klik na red u tablici** → highlight te admin zone na karti + auto-zoom

**Tehnologija**: Leaflet.js, plain HTML/CSS/JS, mobile-friendly (300–400 px width range). Bez React-a / Next.js-a / build-stepa. Service-anywhere statički sadržaj. `@turf/turf` v7 za client-side aggregation (centroidi + point-in-polygon).

## Izvori slika

| Izvor | GSD | Pristup | Korištenje |
|---|---|---|---|
| **City of Zagreb CDOF 2022** (`ZG_CDOF2022`) | ~0,10–0,15 m | `https://geoportal.zagreb.hr/Public/Ortofoto2022_Public/MapServer/WMSServer` (anonimno) | **Primarni izvor** — najbolja rezolucija, gradski ortofoto |
| **DGU DOF LiDAR 2022/23** | 0,25 m | `https://geoportal.dgu.hr/services/inspire/orthophoto_lidar_2022_2023/wms` | Sekundarni; LiDAR intenzitet odvaja asfalt/travu/krov bolje od RGB |
| **DGU DOF5 2023/24** | 0,5 m | `https://geoportal.dgu.hr/services/inspire/orthophoto_2023_2024/wms` | Fallback / nacionalna konzistentnost |
| **DGU DOF 1:1000 (potres)** | ~0,10 m | Restricted; pristup kroz Grad Zagreb | Phase 3 (neslužbena parkirališta) |
| **Zagreb 2018 TMS** (OSM-HR community) | ~0,10 m (z20) | `https://tms.osm-hr.org/zagreb-2018/{z}/{x}/{y}.png` (anonimno, besplatno) | Alternativni izvor — oštrija slika za neke namjene. TMS tile-ovi se stitchaju 4×4 i reprojektiraju u EPSG:3765 skriptom `pipeline/01b_fetch_tms.py`. |
| **Google Maps imagery** | ~0,15 m | API key | Phase 3 alternativni izvor ako gradski ne stigne |
| **Korisnički-osigurani izvor** | TBD | Manual | Faza 3 fallback |

Native CRS za sve hrvatske izvore: **EPSG:3765 (HTRS96/TM)**. Pull u native CRS-u da se izbjegne resampling loss. WMS server vraća `image/geotiff` direktno, georeferenciranje preživi.

## Repository struktura

```
zagreb-parkiralista/
├── README.md               # ovaj dokument
├── .gitignore
├── .env                    # lokalni API ključevi (HF_API_KEY za SAM 3); gitignored
├── package.json            # serviranje viewer-a (npm run dev)
│
├── index.html              # web preglednik (Leaflet)
├── index.css
├── js/
│   └── map.js              # logika preglednika
│
├── pipeline/                # Python ML pipeline za Faze 0–5
│   ├── README.md           # detaljne upute po skripti
│   ├── requirements.txt    # Phase 0 light deps
│   ├── requirements-ml.txt # Phase 1+ heavy deps (torch, transformers, samgeo)
│   ├── 00_fetch_osm.py            # Faza 0 — OSM parking baseline (nodes + ways + rels)
│   ├── 01_fetch_tiles.py          # Faza 1.1 — WMS tile fetcher (CDOF/DOF5)
│   ├── 01b_fetch_tms.py           # Alt tile source — TMS fetcher (zagreb-2018, stitch 4×4 → EPSG:3765)
│   ├── 02_segment.py              # Faza 1.2 — SAM 3 / LangSAM segmentacija
│   ├── 03_vectorize.py            # Faza 1.3 — mask → polygon
│   ├── 04_diff_osm.py             # Faza 1.4 — set-difference vs OSM
│   ├── 10_refine_capacity.py      # Faza 2 — merge OSM + ML, capacity_final
│   ├── 11_detect_vehicles.py      # Faza 3.1 — YOLO vehicle detection (with pixel bbox)
│   ├── 12_export_tile_jpegs.py    # TIFF → JPEG za viewer popup preview
│   ├── 20_detect_informal.py      # Faza 3.2 — informal filter + landuse classify
│   ├── 21_fetch_landuse.py        # Faza 3 prep — OSM landuse polygons
│   ├── 22_fetch_highways.py       # Faza 5 prep — OSM highway network
│   ├── 30_render_composite.py     # Faza 5.1 — stitch tiles + overlay roads/parking/cars
│   └── 31_llm_propose.py          # Faza 5.2 — Claude / GPT vision API → polygon proposals
│
├── yolo-street-view/        # YOLO detekcija na street-view slikama + viewer za inspekciju
│   ├── analyze.py          # YOLO na svim street-view slikama → per-image JSON
│   ├── viewer.html/css/js  # preglednik s bbox overlayima, side-of-street analizom, parking score-om
│   ├── images → ../street-view/out/images  # symlink
│   └── out/yolo-analysis.json              # output (6 MB, 2351 slika, 17530 vozila)
│
├── street-view/             # Faza 6 — self-contained Node.js street-view POC
│   ├── README.md           # detalji + setup + cost model
│   ├── package.json        # vlastiti package + npm scripts
│   ├── review.html         # static human-review UI
│   ├── review.css
│   ├── review.js
│   ├── scripts/
│   │   ├── lib/            # geo / io / parking / billing helpers
│   │   ├── import-road-width-demo.mjs
│   │   ├── prepare-candidates.mjs
│   │   ├── fetch-street-view-metadata.mjs
│   │   ├── fetch-street-view-images.mjs
│   │   ├── analyze-openai.mjs           # GPT-5.4 vision classification
│   │   ├── build-parking-areas.mjs      # AI output → curb polygons
│   │   ├── build-review-bundle.mjs
│   │   ├── submit-openai-batch.mjs     # chunked batch submission
│   │   ├── import-openai-batch.mjs     # download + parse batch results
│   │   ├── process-area.mjs           # ORCHESTRATOR — chains all steps for one area
│   │   ├── ingest-to-db.mjs           # write results to PostGIS
│   │   └── mock-run.mjs                 # offline demo path
│   ├── data/               # input segments
│   ├── out/                # generated images + AI output (gitignored)
│   └── test/               # unit tests for lib/
│
└── data/
    ├── osm/
    │   ├── parking_zagreb.geojson    # Faza 0 output (committed, ~3 MB)
    │   ├── landuse_zagreb.geojson    # Faza 3 prep output (gitignored, ~27 MB, regen via 21_)
    │   └── highways_zagreb.geojson   # Faza 5 prep output (gitignored, ~40 MB, regen via 22_)
    ├── tiles/                # raw imagery tiles GeoTIFF (gitignored — large)
    ├── tiles_jpg/             # JPEG previews za viewer popup (gitignored — generated by 12_export_tile_jpegs.py)
    ├── composites/            # Faza 5 composite PNG-ovi + sidecar metadata JSON (gitignored — generated by 30_render_composite.py)
    ├── masks/                # SAM masks (gitignored — generated)
    ├── candidates/           # ML kandidati prije QA
    │   ├── vehicles.geojson              # Faza 3.1 YOLO output
    │   ├── llm_parking_candidates.geojson # Faza 5.2 LLM output
    │   └── missing_parking.geojson       # Faza 1.4 output (kad SAM 3 unblock)
    └── final/                # finalni publishable layeri
        ├── parking_with_capacity.geojson  # Faza 2 output
        └── informal_parking.geojson       # Faza 3 output
```

Shared API endpoint za administrativne granice je u `/Users/simun/Code/cadastre-data/api/src/domains/borders/routes.js`.

## Quick start

### Setup

```sh
cd pipeline
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt        # Phase 0 + Phase 2 + landuse fetcher
pip install -r requirements-ml.txt     # Phase 1.2 + Phase 3.1 (torch, transformers, samgeo, ultralytics)
pip install "segment-geospatial[samgeo3]"  # SAM 3 specifični extras
```

Za Fazu 1.2 (SAM 3) trebaš HuggingFace token u root `.env`-u:
```
HF_API_KEY=hf_xxxxxxxxxxxxxxxx
```
i traženi access za `facebook/sam3` na huggingface.co.

### Faza 0 — OSM baseline

```sh
cd pipeline && source .venv/bin/activate
python 00_fetch_osm.py
```

Output: `data/osm/parking_zagreb.geojson` (~3 MB, 4.898 features)

### Web preglednik

```sh
cd /Users/simun/Code/zagreb-parkiralista
python3 -m http.server 8000
# ili
npm run dev
```

Otvori `http://localhost:8000/` u pregledniku.

### Faza 1 — ML pipeline (čeka SAM 3 access)

```sh
cd pipeline && source .venv/bin/activate
python 01_fetch_tiles.py --bbox 15.94,45.79,16.02,45.83 --source cdof2022
python 02_segment.py --tiles ../data/tiles/cdof2022 --backend sam3 --prompt "parking lot"
python 03_vectorize.py --masks ../data/masks/cdof2022
python 04_diff_osm.py
```

### Faza 3 — informal parking (radi sad)

```sh
cd pipeline && source .venv/bin/activate

# Skini tile-ove (ili dijelje prošli set)
python 01_fetch_tiles.py --bbox 15.94,45.79,16.02,45.83 --source cdof2022

# Jednom: skini OSM landuse za klasifikaciju (~27 MB)
python 21_fetch_landuse.py

# Detektiraj vozila (default: yolov8n.pt, COCO weights)
python 11_detect_vehicles.py --tiles ../data/tiles/cdof2022 --require-plausible-size

# (Jednom) konvertiraj tile-ove u JPEG za viewer popup
python 12_export_tile_jpegs.py

# Filter + klasifikacija
python 20_detect_informal.py
```

### Faza 5 — LLM cartographer (radi sad)

```sh
cd pipeline && source .venv/bin/activate

# Jednom: skini OSM highway network za overlay (~40 MB)
python 22_fetch_highways.py

# Renderiraj composite. Default --grid 3 (3×3 = 460 m × 460 m); --grid 4 daje 768 m × 768 m
python 30_render_composite.py --center-tile 2980,33035 --grid 4
# ili po WGS84 bbox-u
python 30_render_composite.py --bbox 15.96,45.80,15.98,45.82

# Dry-run (bez API call-a) za QA prompt-a i image kvalitete
python 31_llm_propose.py ../data/composites/cdof2022/composite_tile_2980_33035_g4.png --dry-run

# Default: Claude (treba ANTHROPIC_API_KEY u .env)
python 31_llm_propose.py ../data/composites/cdof2022/composite_tile_2980_33035_g4.png

# OpenAI GPT-4o (treba OPENAI_API_KEY u .env)
python 31_llm_propose.py ../data/composites/cdof2022/composite_tile_2980_33035_g4.png --provider openai

# OpenAI GPT-5 — treba povećani token budget zbog hidden reasoning
python 31_llm_propose.py ../data/composites/cdof2022/composite_tile_2980_33035_g4.png --provider openai --model gpt-5 --max-tokens 10000

# A/B test oba providera na istom composite-u
python 31_llm_propose.py ../data/composites/cdof2022/composite_tile_2980_33035_g4.png --provider both

# Batch nad svim composite-ima u dir-u (default merge: --overwrite za fresh start)
python 31_llm_propose.py --all --provider anthropic
```

Setup za API ključeve (oba su podržana, koristi koji god imaš):

```
# u root .env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-proj-...
```

- Get Anthropic key: https://console.anthropic.com/settings/keys
- Get OpenAI key: https://platform.openai.com/api-keys

**Empirijski savjet** (vidi Ključni nalaz #8): Claude Sonnet 4.6 daje ~17× više kandidata po dolaru od GPT-5 za ovaj task. Default je `--provider anthropic`. GPT je vrijedan jedino kao high-precision second-opinion filter na curated set-u.

### Faza 2 — capacity refinement

```sh
python 10_refine_capacity.py
```

### Pun pipeline (uvijek na svim raspoloživim podacima)

```sh
cd pipeline && source .venv/bin/activate
python 00_fetch_osm.py                          # Faza 0
python 01_fetch_tiles.py                         # Faza 1.1 (može trajati sat+ za veći bbox)
python 21_fetch_landuse.py                       # Faza 3 prep
python 11_detect_vehicles.py --tiles ../data/tiles/cdof2022 --require-plausible-size  # Faza 3.1
python 20_detect_informal.py                     # Faza 3.2
python 10_refine_capacity.py                     # Faza 2
# Faza 1.2–1.4 dolazi kad SAM 3 gating padne:
# python 02_segment.py --tiles ../data/tiles/cdof2022
# python 03_vectorize.py --masks ../data/masks/cdof2022
# python 04_diff_osm.py
```

## Tehnološki stack

- **Backend pipeline**: Python 3.11+ (Python 3.14 u dev venv-u), segment-geospatial 1.3.2, transformers 5.5+, torch 2.11+, ultralytics 8.4+, rasterio, shapely 2.x, pyproj, owslib, requests, Pillow, anthropic 0.92+, openai 2.31+
- **Frontend viewer**: Plain HTML/CSS/JavaScript, Leaflet.js 1.9, @turf/turf 7
- **Shared API**: Hono (Node.js), serviran iz `cadastre-data/api`, PostGIS backend
- **Storage**: GeoJSON files
- **CRS**: EPSG:3765 (HTRS96/TM) za interne računice; EPSG:4326 (WGS84) za GeoJSON output i web preglednik

## Licenca

Otvoreni podaci. Atribucije ovisno o izvoru:
- OSM podaci: ODbL
- DGU ortofoto izvedeni proizvodi: Otvorena dozvola (atribucija DGU)
- Grad Zagreb CDOF izvedeni proizvodi: prema dogovoru s Gradom

## Reference

- segment-geospatial dokumentacija: https://samgeo.gishub.org/
- SAM 3 (Meta): https://github.com/facebookresearch/sam3
- Ultralytics YOLO: https://docs.ultralytics.com/
- Anthropic SDK (vision API): https://docs.claude.com/
- OpenAI SDK (vision API): https://platform.openai.com/docs/guides/vision
- APKLOT dataset (parking lot polygons): https://github.com/langheran/APKLOT
- CARPK (drone car counting): https://lafi.github.io/LPN/
- OSM Overpass API: https://overpass-api.de/
- DGU Geoportal: https://geoportal.dgu.hr/
- Grad Zagreb Geoportal: https://geoportal.zagreb.hr/
- Prior art — parkingzagreb.giscloud.com: https://parkingzagreb.giscloud.com/
- Prior art — ZagrebParking dashboard: https://www.arcgis.com/apps/dashboards/a1a13c9834b040ec84656afd142ca6ce
