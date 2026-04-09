This document describes another way to approach the question of estimating informal parking.

It is based on these insights:

- informal parking is typically in a pattern. It is not a bunch of cars parked all over the
  place (although that exists too). It is typically one of these patterns:
  - cars are parked on the sidewalk on one way of the road
  - cars are parked in one of the lanes
  - cars are parked on gravel along one side of the road
- these patterns will correspond to segments of a road (parts between two intersections)
- if we can get one street-level photo of the segment, we can solve the whole segment

So I am thinking of an automated pipeline line this:

- there is a set of streets to check
- we use a browser (headless like playwright or instrumented on desktop) to go into google maps and activate street view, for each of the streets. We do it in the middle and look both ways, and take two screenshots. For version 1 MVP we take only one screenshot in one direction. The number of screenshots we end up with is manageable, either one or two per street segment
- We use AI image recognition via an API (in batch mode, to save money) to ask a simple question: "What is the situation with parking on this street, pick one of the answers below. To determine that cars do park look that either 1) some cars are present, parked or 2) no cars are present but there are white parking lines on the ground. Even if a picture is taken while the parking is mostly empty we should still classify it as parking as long as there is either some cars in it or parking lines. Do not confuse cars that are in lanes for parked cars (a car in the middle of the road is not parked, nor is a car that has lane markers, dashed white lines, near it on at least one side). If you determine there is parking, try to also determine is it elevated/on sidewalk (A) or road-level (B), and is it formal (C) or informal (D) (all combinations are possible, AC, AD, BC, BD):

1. I can't tell for sure, no decision
2. Cars do not park on this segment
3. Cars park on the left side (manner: parallel, perpendicular or diagonal?)
4. Cars park on the right side (manner: parallel, perpendicular or diagonal?)
5. Cars park on both sides (if not in the same manner, note both manners)

Depending on the answer, we draw a parking polygon on one of the sides of the segment. Not sure if we should use OSM or DGU parcels for segments, check ~/Code/zagreb-road-widths for the approach and learnings from there.

The script is in node.js and get segments as input.
It uses OpenAI API to batch process images and the key is in .env
It saves results into a zagreb db, user zagreb_user, schema parking
table parking.area_informal
It has conclusion_id serial increasing by 1

---

Then there quiz part. We use the saved screenshots and AI analysis and we present them to users, one by one. We create a parking-informal-quiz.html for it. The page has the image on the left, the AI analysis on the right, with the decision and the resulting polygon (maybe shown on map too). The user sees a list of AI conclusions and everything is marked agree and they can click disagree.
The user can click next to see the next image or previous to see previous.
We store the replies in the database, new table parking.human_review

The page uses new api endpoint on zagreb-api API
GET /parking/areas/?type=informal
POST /parking/review/{ai_conclusion_id}

Examine this in light of what we have built so far and what is in pipeline/phases. What is your opinion, would this system be a worthy addition to the toolkit? The goal is to get a full picture of the parking situation in Zagreb, including formal and informal places both.
