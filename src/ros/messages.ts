/**
 * Typed shapes for the ROS 2 messages Fleetline exchanges over rosbridge.
 *
 * rosbridge serializes ROS messages to JSON with the exact field names of the
 * .msg definitions, so these interfaces mirror the real message definitions
 * (nav_msgs/msg/Odometry, sensor_msgs/msg/BatteryState, …) field for field.
 * Fields the console never reads are typed but optional where a partial
 * publisher is plausible — be liberal in what you accept.
 *
 * Type strings use the ROS 2 `package/msg/Name` form, which rosbridge for
 * ROS 2 expects (it also accepts the older `package/Name` form).
 */

export interface RosTime {
  sec: number
  nanosec: number
}

export interface RosHeader {
  stamp: RosTime
  frame_id: string
}

export interface Vector3 {
  x: number
  y: number
  z: number
}

export interface Point {
  x: number
  y: number
  z: number
}

export interface Quaternion {
  x: number
  y: number
  z: number
  w: number
}

export interface Pose {
  position: Point
  orientation: Quaternion
}

export interface Twist {
  linear: Vector3
  angular: Vector3
}

/** nav_msgs/msg/Odometry */
export interface Odometry {
  header: RosHeader
  child_frame_id: string
  pose: { pose: Pose; covariance?: number[] }
  twist: { twist: Twist; covariance?: number[] }
}

/**
 * sensor_msgs/msg/BatteryState (the fields the console uses plus common
 * companions). Note `percentage` is defined by the message spec as a charge
 * fraction in [0, 1] — the console converts to percent for display.
 */
export interface BatteryState {
  header: RosHeader
  voltage?: number
  percentage: number
  current?: number
  charge?: number
  capacity?: number
  design_capacity?: number
  power_supply_status?: number
  power_supply_health?: number
  power_supply_technology?: number
  present?: boolean
  location?: string
  serial_number?: string
}

/** geometry_msgs/msg/PoseStamped */
export interface PoseStamped {
  header: RosHeader
  pose: Pose
}

/** std_msgs/msg/Bool */
export interface BoolMsg {
  data: boolean
}

/** std_msgs/msg/String */
export interface StringMsg {
  data: string
}

export const MSG_TYPES = {
  odometry: 'nav_msgs/msg/Odometry',
  batteryState: 'sensor_msgs/msg/BatteryState',
  poseStamped: 'geometry_msgs/msg/PoseStamped',
  bool: 'std_msgs/msg/Bool',
  string: 'std_msgs/msg/String',
} as const

/** Wall-clock ROS time for outgoing message headers (live mode is not the
 * deterministic sim — wall time is correct here). */
export function rosNow(): RosTime {
  const ms = Date.now()
  return { sec: Math.floor(ms / 1000), nanosec: (ms % 1000) * 1_000_000 }
}
