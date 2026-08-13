# Running Fleetline against ROS 2

Fleetline's **ROS BRIDGE** mode speaks the
[rosbridge v2 JSON protocol](https://github.com/RobotWebTools/rosbridge_suite/blob/ros2/ROSBRIDGE_PROTOCOL.md)
over a websocket. Anything that runs `rosbridge_server` in front of a ROS 2
graph can feed the console — a Gazebo simulation, a real robot, or the bundled
mock (`npm run mock-ros`).

This document covers: the topic contract, the coordinate transform, exact
steps for a TurtleBot3 + Nav2 + Gazebo setup on a personal machine, and an
honest statement of what has and has not been tested.

---

## 1. Topic contract

Per robot, under a namespace `ns` (e.g. `amr_6` → roster id `AMR-6`;
`nsToRobotId` uppercases and swaps `_` for `-`):

| Topic | Type | Direction | Console use |
| --- | --- | --- | --- |
| `/<ns>/odom` | `nav_msgs/msg/Odometry` | subscribe | pose on the grid; MOVING/IDLE from twist magnitude (> 0.02 m/s) |
| `/<ns>/battery_state` | `sensor_msgs/msg/BatteryState` | subscribe | battery percent (`percentage` in [0, 1] per the spec; values > 1 are treated as already-percent) |
| `/<ns>/goal_pose` | `geometry_msgs/msg/PoseStamped` | advertise + publish | station / charge dispatch (`frame_id: map`, identity orientation) |
| `/<ns>/emergency_stop` | `std_msgs/msg/Bool` | advertise + publish | e-stop (`true`) and release (`false`) |
| `/fleet/status` | `std_msgs/msg/String` | subscribe | roster discovery — `data` is JSON: `{"robots":[{"ns":"amr_6","model":"100kg"}, …]}` |

Notes on the contract:

- **`/fleet/status` is a stand-in.** ROS 2 has no standard fleet-roster
  message; real deployments use vendor topics or Open-RMF's
  `rmf_fleet_msgs/FleetState`. Fleetline reads a `std_msgs/String` JSON
  payload so the discovery path works without custom message definitions on
  the rosbridge host. If your system has no such topic, skip discovery
  entirely with the `?robots=` URL parameter (below). `model` is optional
  (`100kg` | `600kg` | `1500kg`, default `100kg`) and only affects the drawn
  footprint/label.
- A robot enters the roster on its **first odometry fix** (so it appears
  where it actually is). If no `battery_state` arrives within 2 s of the
  first odom, it is admitted with battery shown as **0 %** and an explicit
  event-log line — the console never invents a charge level.
- `goal_pose` follows the Nav2 convention (the
  [`nav2_simple_commander` / RViz "Nav2 Goal" topic interface](https://docs.nav2.org/)):
  publishing a `PoseStamped` on the right topic starts navigation. The
  console publishes identity orientation — add a goal-heading UI before using
  this where final heading matters.
- `emergency_stop` is **not** a standard Nav2 topic. Map it to whatever your
  robot exposes (a relay node calling the vendor stop service, a
  `twist_mux` lock, etc.). The mock implements it directly.
- Commands that would need a fleet manager or a Nav2 **action** client
  (task abort, reroute/replan) are refused with a stated reason rather than
  faked. rosbridge does expose action interfaces; wiring
  `nav2_msgs/action/NavigateToPose` (with feedback → live progress, cancel →
  real abort) is the natural next step.

## 2. Coordinate transform (world metres → warehouse grid)

Defined in `src/ros/transform.ts`. ROS world frames follow REP-103
(x east, y north); the console grid is screen-oriented (y grows south), so:

```
gridX = originCellX + worldX / metersPerCell
gridY = originCellY − worldY / metersPerCell     // note the y flip
```

Defaults: `metersPerCell = 0.5`, origin at grid cell `(22, 13)` — the world
origin sits at the centre of the 44 × 26 grid and the drawable floor spans
roughly x ∈ [−11, +11] m, y ∈ [−6.5, +6.5] m.

Configure per deployment with URL parameters (values come from your map's
`map.yaml`, not from this console):

```
?cellm=0.5&originx=22&originy=13
```

Odometry that maps outside the grid is clamped for drawing and flagged once
per robot in the event log ("adjust the scale/offset transform").

## 3. URL parameters (scriptable startup)

```
http://localhost:5173/?source=ros&bridge=ws://localhost:9090&robots=amr_1&cellm=0.1&originx=22&originy=13
```

| Param | Meaning |
| --- | --- |
| `source=ros` | start in ROS BRIDGE mode |
| `bridge=` | rosbridge websocket URL (default `ws://localhost:9090`) |
| `robots=` | comma-separated namespaces to register without `/fleet/status` |
| `cellm=`, `originx=`, `originy=` | transform overrides (section 2) |

Everything is also reachable interactively: the top-bar DATA SOURCE switch
and the BRIDGE… popover (URL + APPLY & CONNECT), with a
CONNECTING / CONNECTED / ERROR chip and auto-retry with backoff.

## 4. Smoke test with the bundled mock (no ROS required)

```bash
npm run mock-ros                     # ws://localhost:9090, clearly labelled a mock
npm run dev                          # then open:
# http://localhost:5173/?source=ros&bridge=ws://localhost:9090
```

Two mock robots (`amr_6`, `amr_7`) patrol the aisles, drain battery, accept
`goal_pose`, and freeze on `emergency_stop`.

## 5. Real ROS 2: TurtleBot3 + Nav2 + Gazebo (single robot)

Tested procedure shape only — see the honesty section below. On a machine
with Docker (Linux with an X server is simplest for the Gazebo GUI; headless
also works):

**5.1 Start the TurtleBot3 sim + Nav2** (official OSRF/ROS images; ROS 2
Humble shown):

```bash
docker network create rosnet

# Gazebo + TurtleBot3 world + Nav2 + AMCL, headless:
docker run -it --rm --name tb3 --network rosnet \
  -e TURTLEBOT3_MODEL=burger \
  osrf/ros:humble-desktop-full \
  bash -lc "apt-get update && apt-get install -y ros-humble-turtlebot3-gazebo ros-humble-nav2-bringup && \
    ros2 launch nav2_bringup tb3_simulation_launch.py headless:=True use_rviz:=False"
```

**5.2 Start rosbridge** on the same ROS domain/network:

```bash
docker run -it --rm --name rosbridge --network rosnet -p 9090:9090 \
  osrf/ros:humble-desktop \
  bash -lc "apt-get update && apt-get install -y ros-humble-rosbridge-suite && \
    ros2 launch rosbridge_server rosbridge_websocket_launch.xml"
```

(Both containers must share DDS discovery: same docker network works with
default multicast; otherwise set `ROS_DOMAIN_ID` in both and consider
`RMW_IMPLEMENTATION=rmw_cyclonedds_cpp`.)

**5.3 Topic remapping.** A stock TurtleBot3 publishes in the root namespace
(`/odom`, `/battery_state`, goal on `/goal_pose`), while Fleetline expects
per-robot namespaces. Two options:

- *Console-side (no remap):* register the "namespace-less" robot is not
  supported — Fleetline always prefixes `/<ns>/`. So:
- *ROS-side relay* (simplest for one robot):

  ```bash
  ros2 run topic_tools relay /odom /amr_1/odom &
  ros2 run topic_tools relay /battery_state /amr_1/battery_state &
  ros2 run topic_tools relay /amr_1/goal_pose /goal_pose &
  ```

  For `emergency_stop`, no stock equivalent exists; a minimal bridge is a
  ten-line node that subscribes `/amr_1/emergency_stop` (`std_msgs/Bool`) and
  calls Nav2's lifecycle pause or publishes a zero `cmd_vel` lock. Multi-robot
  Nav2 bringups (`unique_multi_tb3_simulation_launch.py`) already namespace
  everything (`/robot1/odom`, …) — then only the `emergency_stop` shim is
  needed, plus `?robots=robot1,robot2`.

**5.4 Point the console at it:**

```
http://localhost:5173/?source=ros&bridge=ws://localhost:9090&robots=amr_1&cellm=0.1&originx=22&originy=13
```

`cellm=0.1` because the TurtleBot3 world is ~10 m across — at 0.1 m/cell the
±2 m world maps to a readable region of the grid. Compute your own from
`map.yaml` (`resolution`, `origin`) if you want the warehouse drawing to
correspond to map cells.

**5.5 What you should see:** `AMR-1` appears on first odom (battery at 0 %
with a log note if the sim exposes no `/battery_state` — the TurtleBot3
Gazebo sim generally does not); selecting it and clicking a station publishes
a `PoseStamped` that Nav2 executes; the robot's live pose tracks across the
grid.

## 6. What was tested vs. what was not (honesty section)

**Tested (automated, in this repo, against the mock):**

- `RosbridgeClient` ↔ mock server over real websockets on an ephemeral port:
  subscribe/odometry streaming, advertise+publish (`goal_pose` convergence,
  `emergency_stop` freeze/release), publish-before-advertise rejection,
  unsubscribe, id-matched `call_service` responses, and automatic
  reconnect-with-backoff replaying the subscription registry
  (`src/ros/__tests__/rosbridge.test.ts`).
- `RosFleetBridge` ↔ mock server: `/fleet/status` discovery → roster
  admission with live pose/battery, grid-transform placement, goto/charge
  goal publication with ARRIVAL detection, per-robot and global e-stop
  mirroring, honest refusals for reroute/abort
  (`src/ros/__tests__/fleet.test.ts`).
- The transform math (`src/ros/__tests__/transform.test.ts`).
- The full UI path manually via a scripted browser session against the built
  app + mock server (connection chip, discovery, live movement, commands).

**NOT tested (no ROS 2 available in this environment):**

- A real `rosbridge_server` — field naming and op sequencing follow the
  protocol spec and mirror roslibjs behaviour, but no live-bridge
  interop run has been done.
- Real Gazebo/Nav2 (section 5 is a written procedure, not a lab report):
  DDS/QoS quirks (e.g. sensor-data QoS on `/odom` — rosbridge usually
  handles this, unverified here), clock/`use_sim_time` interactions, Nav2
  goal preemption behaviour when spamming `goal_pose`.
- **Frame honesty:** the console renders `/odom` poses as if they were
  map-frame positions. In a real system odometry drifts; the right source is
  `amcl_pose` (or TF `map→base_link`), which is a one-line topic/type swap in
  `src/ros/fleet.ts` but is untested. The mock publishes drift-free poses, so
  this simplification is invisible in the demo — it will not be on a real
  robot.
- `BatteryState` from a real BMS (units/sign conventions vary by driver).

**Known limitations by design:** no planned-path overlay in ROS mode (would
subscribe `/plan`), no goal orientation UI, single fleet-status schema, no
Nav2 action client (so no cancel/feedback), and the e-stop topic is a
convention this console defines rather than a ROS standard.
