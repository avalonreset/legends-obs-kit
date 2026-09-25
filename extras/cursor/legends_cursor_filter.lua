-- SPDX-License-Identifier: GPL-2.0-or-later
-- Copyright (c) 2026 Avalon Reset

local obs = obslua
local ffi = require "ffi"
local bit = require "bit"

ffi.cdef[[
typedef struct { long x; long y; } POINT;
bool GetCursorPos(POINT *lpPoint);
short GetAsyncKeyState(int vKey);
]]

local user32 = ffi.load("user32")
local VK_LBUTTON = 0x01
local VK_RBUTTON = 0x02
local cursor_pos = ffi.new("POINT")

local MODE_CLASSIC = 0
local MODE_MOMENTUM = 1
local MODE_COMET = 2
local MODE_STRETCH = 3
local MODE_FINDER = 4

local SHAPE_CIRCLE = 0
local SHAPE_DIAMOND = 1
local SHAPE_SQUIRCLE = 2

local ACT_LINEAR = 0
local ACT_QUADRATIC = 1
local ACT_SNAPPY = 2

local source_def = {}
source_def.id = "legends_cursor_source"
source_def.type = obs.OBS_SOURCE_TYPE_SOURCE
source_def.output_flags = bit.bor(obs.OBS_SOURCE_VIDEO, obs.OBS_SOURCE_CUSTOM_DRAW)

local filter_def = {}
filter_def.id = "legends_cursor_filter"
filter_def.type = obs.OBS_SOURCE_TYPE_FILTER
filter_def.output_flags = bit.bor(obs.OBS_SOURCE_VIDEO, obs.OBS_SOURCE_CUSTOM_DRAW)

local DEFAULTS = {
  width = 3840,
  height = 2160,
  origin_x = 0,
  origin_y = 0,
  visual_mode = MODE_MOMENTUM,
  shape_mode = SHAPE_CIRCLE,
  activation_mode = ACT_SNAPPY,
  radius = 82.0,
  thickness = 12.0,
  glow = 90.0,
  opacity = 0.92,
  enable_floaty_follow = true,
  follow_lag_ms = 255.0,
  enable_idle_pulse = true,
  enable_motion_ticks = true,
  enable_laser_wake = true,
  enable_comet_trail = true,
  enable_stretch_warp = true,
  enable_left_click = true,
  enable_right_click = true,
  idle_activity = 0.22,
  mode_strength = 1.0,
  speed_limit = 3200.0,
  click_size = 330.0,
  click_duration = 0.70,
  left_intensity = 1.0,
  right_intensity = 1.0,
  motion_spin = 1.0,
  motion_decay = 5.5,
  motion_ticks = 0.85,
  tick_count = 10.0,
  stretch_strength = 0.70,
  wake_strength = 0.60,
  trail_strength = 0.55,
  trail_spacing = 0.030,
  trail_duration = 0.42,
  finder_enabled = true,
  finder_sensitivity = 6.0,
  finder_size = 1.90,
  finder_decay = 2.2,
  main_r = 0.0,
  main_g = 1.0,
  main_b = 0.47,
  accent_r = 0.18,
  accent_g = 0.80,
  accent_b = 1.0,
  left_r = 1.0,
  left_g = 1.0,
  left_b = 1.0,
  right_r = 1.0,
  right_g = 0.18,
  right_b = 0.78,
}

local function clamp(v, lo, hi)
  if v < lo then return lo end
  if v > hi then return hi end
  return v
end

local function pressed(vk)
  return user32.GetAsyncKeyState(vk) < 0
end

local function has_user_value(settings, name)
  if obs.obs_data_has_user_value == nil then
    return true
  end
  return obs.obs_data_has_user_value(settings, name)
end

local function get_int(settings, name)
  if not has_user_value(settings, name) then
    return DEFAULTS[name]
  end
  return obs.obs_data_get_int(settings, name)
end

local function get_bool(settings, name)
  if not has_user_value(settings, name) then
    return DEFAULTS[name]
  end
  return obs.obs_data_get_bool(settings, name)
end

local function get_double(settings, name)
  if not has_user_value(settings, name) then
    return DEFAULTS[name]
  end
  return obs.obs_data_get_double(settings, name)
end

local function get_cursor_xy(data)
  if user32.GetCursorPos(cursor_pos) then
    return cursor_pos.x - data.origin_x, cursor_pos.y - data.origin_y
  end
  return data.mouse_x or 0.0, data.mouse_y or 0.0
end

local function set_float(param, value)
  if param == nil or param == ffi.NULL then return end
  obs.gs_effect_set_float(param, tonumber(value) or 0.0)
end

local function set_int(param, value)
  if param == nil or param == ffi.NULL then return end
  obs.gs_effect_set_int(param, tonumber(value) or 0)
end

local function set_vec4(param, x, y, z, w)
  if param == nil or param == ffi.NULL then return end
  local value = obs.vec4()
  value.x = tonumber(x) or 0.0
  value.y = tonumber(y) or 0.0
  value.z = tonumber(z) or 0.0
  value.w = tonumber(w) or 0.0
  obs.gs_effect_set_vec4(param, value)
end

local function activation_curve(data, speed_px)
  local limit = math.max(data.speed_limit or DEFAULTS.speed_limit, 1.0)
  local t = clamp(speed_px / limit, 0.0, 1.0)
  if data.activation_mode == ACT_QUADRATIC then
    return t * t
  end
  if data.activation_mode == ACT_SNAPPY then
    return 1.0 - ((1.0 - t) * (1.0 - t))
  end
  return t
end

local function read_settings(data, settings)
  data.width = math.max(1, get_int(settings, "width"))
  data.height = math.max(1, get_int(settings, "height"))
  data.origin_x = get_int(settings, "origin_x")
  data.origin_y = get_int(settings, "origin_y")
  data.visual_mode = get_int(settings, "visual_mode")
  data.shape_mode = get_int(settings, "shape_mode")
  data.activation_mode = get_int(settings, "activation_mode")

  data.radius = get_double(settings, "radius")
  data.thickness = get_double(settings, "thickness")
  data.glow = get_double(settings, "glow")
  data.opacity = get_double(settings, "opacity")
  data.enable_floaty_follow = get_bool(settings, "enable_floaty_follow")
  data.follow_lag_ms = get_double(settings, "follow_lag_ms")
  data.enable_idle_pulse = get_bool(settings, "enable_idle_pulse")
  data.enable_motion_ticks = get_bool(settings, "enable_motion_ticks")
  data.enable_laser_wake = get_bool(settings, "enable_laser_wake")
  data.enable_comet_trail = get_bool(settings, "enable_comet_trail")
  data.enable_stretch_warp = get_bool(settings, "enable_stretch_warp")
  data.enable_left_click = get_bool(settings, "enable_left_click")
  data.enable_right_click = get_bool(settings, "enable_right_click")
  data.idle_activity = get_double(settings, "idle_activity")
  data.mode_strength = get_double(settings, "mode_strength")
  data.speed_limit = get_double(settings, "speed_limit")
  data.click_size = get_double(settings, "click_size")
  data.click_duration = get_double(settings, "click_duration")
  data.left_intensity = get_double(settings, "left_intensity")
  data.right_intensity = get_double(settings, "right_intensity")
  data.motion_spin = get_double(settings, "motion_spin")
  data.motion_decay = get_double(settings, "motion_decay")
  data.motion_ticks = get_double(settings, "motion_ticks")
  data.tick_count = get_double(settings, "tick_count")
  data.stretch_strength = get_double(settings, "stretch_strength")
  data.wake_strength = get_double(settings, "wake_strength")
  data.trail_strength = get_double(settings, "trail_strength")
  data.trail_spacing = get_double(settings, "trail_spacing")
  data.trail_duration = get_double(settings, "trail_duration")
  data.finder_enabled = get_bool(settings, "finder_enabled")
  data.finder_sensitivity = get_double(settings, "finder_sensitivity")
  data.finder_size = get_double(settings, "finder_size")
  data.finder_decay = get_double(settings, "finder_decay")

  data.main_r = get_double(settings, "main_r")
  data.main_g = get_double(settings, "main_g")
  data.main_b = get_double(settings, "main_b")
  data.accent_r = get_double(settings, "accent_r")
  data.accent_g = get_double(settings, "accent_g")
  data.accent_b = get_double(settings, "accent_b")
  data.left_r = get_double(settings, "left_r")
  data.left_g = get_double(settings, "left_g")
  data.left_b = get_double(settings, "left_b")
  data.right_r = get_double(settings, "right_r")
  data.right_g = get_double(settings, "right_g")
  data.right_b = get_double(settings, "right_b")
end

local function set_default_values(settings)
  obs.obs_data_set_default_int(settings, "width", DEFAULTS.width)
  obs.obs_data_set_default_int(settings, "height", DEFAULTS.height)
  obs.obs_data_set_default_int(settings, "origin_x", DEFAULTS.origin_x)
  obs.obs_data_set_default_int(settings, "origin_y", DEFAULTS.origin_y)
  obs.obs_data_set_default_int(settings, "visual_mode", DEFAULTS.visual_mode)
  obs.obs_data_set_default_int(settings, "shape_mode", DEFAULTS.shape_mode)
  obs.obs_data_set_default_int(settings, "activation_mode", DEFAULTS.activation_mode)

  for name, value in pairs(DEFAULTS) do
    if type(value) == "number" and name ~= "width" and name ~= "height" and name ~= "origin_x" and name ~= "origin_y"
      and name ~= "visual_mode" and name ~= "shape_mode" and name ~= "activation_mode" then
      obs.obs_data_set_default_double(settings, name, value)
    elseif type(value) == "boolean" then
      obs.obs_data_set_default_bool(settings, name, value)
    end
  end
end

local function add_color_sliders(props, prefix, label)
  obs.obs_properties_add_text(props, prefix .. "_label", label, obs.OBS_TEXT_INFO)
  obs.obs_properties_add_float_slider(props, prefix .. "_r", "Red", 0.0, 1.0, 0.01)
  obs.obs_properties_add_float_slider(props, prefix .. "_g", "Green", 0.0, 1.0, 0.01)
  obs.obs_properties_add_float_slider(props, prefix .. "_b", "Blue", 0.0, 1.0, 0.01)
end

local function add_click(data, button)
  local x, y = get_cursor_xy(data)
  table.insert(data.clicks, 1, {
    x = clamp(x, -10000.0, 10000.0),
    y = clamp(y, -10000.0, 10000.0),
    t = data.time,
    button = button
  })
  while #data.clicks > 8 do
    table.remove(data.clicks)
  end
end

local function add_trail(data)
  table.insert(data.trail, 1, {
    x = data.mouse_x,
    y = data.mouse_y,
    t = data.time,
    speed = clamp(data.speed_active, 0.0, 1.0)
  })
  while #data.trail > 8 do
    table.remove(data.trail)
  end
end

source_def.get_name = function()
  return "Legends Cursor Source"
end

source_def.create = function(settings, source)
  local data = {
    source = source,
    width = DEFAULTS.width,
    height = DEFAULTS.height,
    origin_x = DEFAULTS.origin_x,
    origin_y = DEFAULTS.origin_y,
    time = 0.0,
    mouse_x = 0.0,
    mouse_y = 0.0,
    prev_mouse_x = nil,
    prev_mouse_y = nil,
    vel_x = 0.0,
    vel_y = 0.0,
    prev_vel_x = 0.0,
    prev_vel_y = 0.0,
    speed_px = 0.0,
    speed_active = 0.0,
    spin_phase = 0.0,
    spin_velocity = 0.0,
    shake_energy = 0.0,
    shake_amount = 0.0,
    last_trail_time = -999.0,
    last_l = false,
    last_r = false,
    is_filter = false,
    clicks = {},
    trail = {},
    params = {}
  }

  read_settings(data, settings)

  obs.obs_enter_graphics()
  data.effect = obs.gs_effect_create(EFFECT, "legends_cursor_source", nil)
  if data.effect ~= nil then
    local names = {
      "width", "height", "time", "mouse_x", "mouse_y",
      "filter_mode",
      "visual_mode", "shape_mode",
      "radius", "thickness", "glow", "opacity", "idle_activity",
      "mode_strength", "click_size", "click_duration",
      "left_intensity", "right_intensity",
      "speed_active", "spin_phase", "vel_x", "vel_y",
      "motion_ticks", "tick_count", "stretch_strength", "wake_strength",
      "trail_strength", "trail_duration",
      "shake_amount", "finder_size",
      "main_r", "main_g", "main_b",
      "accent_r", "accent_g", "accent_b",
      "left_r", "left_g", "left_b",
      "right_r", "right_g", "right_b",
      "click1", "click2", "click3", "click4",
      "click5", "click6", "click7", "click8",
      "trail1", "trail2", "trail3", "trail4",
      "trail5", "trail6", "trail7", "trail8"
    }
    for _, name in ipairs(names) do
      data.params[name] = obs.gs_effect_get_param_by_name(data.effect, name)
    end
  end
  obs.obs_leave_graphics()

  if data.effect == nil then
    obs.script_log(obs.OBS_LOG_ERROR, "Legends Cursor failed to compile its source shader.")
  end

  return data
end

source_def.destroy = function(data)
  if data ~= nil and data.effect ~= nil then
    obs.obs_enter_graphics()
    obs.gs_effect_destroy(data.effect)
    obs.obs_leave_graphics()
    data.effect = nil
  end
end

source_def.get_defaults = function(settings)
  set_default_values(settings)
end

source_def.get_properties = function(data)
  local props = obs.obs_properties_create()

  local mode = obs.obs_properties_add_list(props, "visual_mode", "Visual mode", obs.OBS_COMBO_TYPE_LIST, obs.OBS_COMBO_FORMAT_INT)
  obs.obs_property_list_add_int(mode, "Classic halo", MODE_CLASSIC)
  obs.obs_property_list_add_int(mode, "Momentum ticks", MODE_MOMENTUM)
  obs.obs_property_list_add_int(mode, "Comet trail", MODE_COMET)
  obs.obs_property_list_add_int(mode, "Stretch warp", MODE_STRETCH)
  obs.obs_property_list_add_int(mode, "Finder pulse", MODE_FINDER)

  local shape = obs.obs_properties_add_list(props, "shape_mode", "Shape", obs.OBS_COMBO_TYPE_LIST, obs.OBS_COMBO_FORMAT_INT)
  obs.obs_property_list_add_int(shape, "Circle", SHAPE_CIRCLE)
  obs.obs_property_list_add_int(shape, "Diamond", SHAPE_DIAMOND)
  obs.obs_property_list_add_int(shape, "Squircle", SHAPE_SQUIRCLE)

  local activation = obs.obs_properties_add_list(props, "activation_mode", "Speed response", obs.OBS_COMBO_TYPE_LIST, obs.OBS_COMBO_FORMAT_INT)
  obs.obs_property_list_add_int(activation, "Linear", ACT_LINEAR)
  obs.obs_property_list_add_int(activation, "Quadratic", ACT_QUADRATIC)
  obs.obs_property_list_add_int(activation, "Snappy", ACT_SNAPPY)

  obs.obs_properties_add_int(props, "width", "Canvas width", 1, 7680, 1)
  obs.obs_properties_add_int(props, "height", "Canvas height", 1, 4320, 1)
  obs.obs_properties_add_int(props, "origin_x", "Monitor origin X", -20000, 20000, 1)
  obs.obs_properties_add_int(props, "origin_y", "Monitor origin Y", -20000, 20000, 1)

  obs.obs_properties_add_text(props, "follow_label", "Follow behavior", obs.OBS_TEXT_INFO)
  obs.obs_properties_add_bool(props, "enable_floaty_follow", "Enable floaty follow")
  obs.obs_properties_add_float_slider(props, "follow_lag_ms", "Floaty lag ms", 1.0, 600.0, 1.0)

  obs.obs_properties_add_text(props, "toggles_label", "Effect toggles", obs.OBS_TEXT_INFO)
  obs.obs_properties_add_bool(props, "enable_idle_pulse", "Enable idle pulse")
  obs.obs_properties_add_bool(props, "enable_motion_ticks", "Enable rotating ticks")
  obs.obs_properties_add_bool(props, "enable_laser_wake", "Enable laser/wake line")
  obs.obs_properties_add_bool(props, "enable_comet_trail", "Enable comet afterimages")
  obs.obs_properties_add_bool(props, "enable_stretch_warp", "Enable stretch warp")
  obs.obs_properties_add_bool(props, "enable_left_click", "Enable left-click effect")
  obs.obs_properties_add_bool(props, "enable_right_click", "Enable right-click effect")

  obs.obs_properties_add_text(props, "amounts_label", "Effect amounts", obs.OBS_TEXT_INFO)
  obs.obs_properties_add_float_slider(props, "radius", "Halo radius", 5.0, 300.0, 1.0)
  obs.obs_properties_add_float_slider(props, "thickness", "Ring thickness", 1.0, 80.0, 1.0)
  obs.obs_properties_add_float_slider(props, "glow", "Glow size", 0.0, 300.0, 1.0)
  obs.obs_properties_add_float_slider(props, "opacity", "Opacity", 0.0, 1.0, 0.01)
  obs.obs_properties_add_float_slider(props, "idle_activity", "Idle pulse", 0.0, 1.0, 0.01)
  obs.obs_properties_add_float_slider(props, "mode_strength", "Overall extra effects strength", 0.0, 2.5, 0.01)
  obs.obs_properties_add_float_slider(props, "speed_limit", "Full-speed threshold px/s", 250.0, 9000.0, 50.0)

  obs.obs_properties_add_float_slider(props, "click_size", "Click ripple size", 0.0, 700.0, 1.0)
  obs.obs_properties_add_float_slider(props, "click_duration", "Click duration", 0.05, 3.0, 0.01)
  obs.obs_properties_add_float_slider(props, "left_intensity", "Left click intensity", 0.0, 2.5, 0.01)
  obs.obs_properties_add_float_slider(props, "right_intensity", "Right click intensity", 0.0, 2.5, 0.01)

  obs.obs_properties_add_float_slider(props, "motion_spin", "Motion spin response", 0.0, 3.0, 0.01)
  obs.obs_properties_add_float_slider(props, "motion_decay", "Motion spin decay", 1.0, 14.0, 0.1)
  obs.obs_properties_add_float_slider(props, "motion_ticks", "Rotating tick intensity", 0.0, 2.0, 0.01)
  obs.obs_properties_add_float_slider(props, "tick_count", "Tick count", 3.0, 24.0, 1.0)
  obs.obs_properties_add_float_slider(props, "stretch_strength", "Stretch warp amount", 0.0, 2.0, 0.01)
  obs.obs_properties_add_float_slider(props, "wake_strength", "Laser/wake line strength", 0.0, 2.0, 0.01)
  obs.obs_properties_add_float_slider(props, "trail_strength", "Comet afterimage strength", 0.0, 2.0, 0.01)
  obs.obs_properties_add_float_slider(props, "trail_spacing", "Trail spacing sec", 0.01, 0.18, 0.005)
  obs.obs_properties_add_float_slider(props, "trail_duration", "Trail duration", 0.05, 1.5, 0.01)

  obs.obs_properties_add_bool(props, "finder_enabled", "Shake finder enabled")
  obs.obs_properties_add_float_slider(props, "finder_sensitivity", "Shake finder sensitivity", 1.0, 20.0, 0.1)
  obs.obs_properties_add_float_slider(props, "finder_size", "Shake finder size", 1.0, 5.0, 0.05)
  obs.obs_properties_add_float_slider(props, "finder_decay", "Shake finder decay", 0.5, 8.0, 0.1)

  add_color_sliders(props, "main", "Main halo color")
  add_color_sliders(props, "accent", "Accent / trail color")
  add_color_sliders(props, "left", "Left click color")
  add_color_sliders(props, "right", "Right click color")
  return props
end

source_def.update = function(data, settings)
  if data ~= nil then
    read_settings(data, settings)
  end
end

source_def.get_width = function(data)
  return data and data.width or 1
end

source_def.get_height = function(data)
  return data and data.height or 1
end

source_def.video_tick = function(data, seconds)
  if data == nil then return end
  if data.is_filter then
    local target = obs.obs_filter_get_target(data.source)
    if target ~= nil then
      data.width = math.max(1, tonumber(obs.obs_source_get_base_width(target)) or data.width or DEFAULTS.width)
      data.height = math.max(1, tonumber(obs.obs_source_get_base_height(target)) or data.height or DEFAULTS.height)
    end
  end

  local dt = clamp(seconds or 0.0, 0.001, 0.100)
  data.time = data.time + dt

  local x, y = get_cursor_xy(data)
  local target_x = clamp(x, -10000.0, 10000.0)
  local target_y = clamp(y, -10000.0, 10000.0)

  if data.prev_mouse_x == nil or data.prev_mouse_y == nil then
    data.mouse_x = target_x
    data.mouse_y = target_y
  elseif data.enable_floaty_follow then
    local lag = math.max(data.follow_lag_ms or DEFAULTS.follow_lag_ms, 1.0) / 1000.0
    local follow = clamp(1.0 - math.exp(-dt / lag), 0.0, 1.0)
    data.mouse_x = data.mouse_x + (target_x - data.mouse_x) * follow
    data.mouse_y = data.mouse_y + (target_y - data.mouse_y) * follow
  else
    data.mouse_x = target_x
    data.mouse_y = target_y
  end

  if data.prev_mouse_x ~= nil and data.prev_mouse_y ~= nil then
    local dx = data.mouse_x - data.prev_mouse_x
    local dy = data.mouse_y - data.prev_mouse_y
    local vx = dx / dt
    local vy = dy / dt
    local speed = math.sqrt(vx * vx + vy * vy)
    local blend = clamp(dt * 12.0, 0.0, 1.0)

    data.vel_x = data.vel_x + (vx - data.vel_x) * blend
    data.vel_y = data.vel_y + (vy - data.vel_y) * blend
    data.speed_px = data.speed_px + (speed - data.speed_px) * blend
    data.speed_active = data.speed_active + (activation_curve(data, data.speed_px) - data.speed_active) * blend

    local decay = math.exp(-math.max(data.motion_decay, 0.1) * dt)
    data.spin_velocity = data.spin_velocity * decay + (dx / math.max(data.width, 1)) * data.motion_spin * 28.0
    data.spin_phase = data.spin_phase + data.spin_velocity * dt * 10.0

    if data.finder_enabled then
      local prev_mag = math.sqrt(data.prev_vel_x * data.prev_vel_x + data.prev_vel_y * data.prev_vel_y)
      local mag = math.sqrt(data.vel_x * data.vel_x + data.vel_y * data.vel_y)
      if prev_mag > 50.0 and mag > 50.0 then
        local dot = (data.prev_vel_x * data.vel_x + data.prev_vel_y * data.vel_y) / (prev_mag * mag)
        local reversal = math.max(0.0, -dot)
        if reversal > 0.35 then
          data.shake_energy = data.shake_energy + reversal * clamp(mag / (data.finder_sensitivity * 900.0), 0.0, 1.0)
        end
      end
      data.shake_energy = math.max(0.0, data.shake_energy - dt * data.finder_decay)
      data.shake_amount = clamp(data.shake_energy, 0.0, 1.0)
    else
      data.shake_energy = 0.0
      data.shake_amount = 0.0
    end

    data.prev_vel_x = data.vel_x
    data.prev_vel_y = data.vel_y

    local dist = math.sqrt(dx * dx + dy * dy)
    local interval = math.max(data.trail_spacing, 0.01)
    if data.enable_comet_trail and data.speed_active > 0.03 and dist > 2.0 and data.time - data.last_trail_time >= interval then
      add_trail(data)
      data.last_trail_time = data.time
    end
  end

  data.prev_mouse_x = data.mouse_x
  data.prev_mouse_y = data.mouse_y

  local l = pressed(VK_LBUTTON)
  local r = pressed(VK_RBUTTON)
  if data.enable_left_click and l and not data.last_l then add_click(data, 1.0) end
  if data.enable_right_click and r and not data.last_r then add_click(data, 2.0) end
  data.last_l = l
  data.last_r = r

  local alive_clicks = {}
  for _, click in ipairs(data.clicks) do
    if data.time - click.t <= data.click_duration then
      table.insert(alive_clicks, click)
    end
  end
  data.clicks = alive_clicks

  local alive_trail = {}
  for _, item in ipairs(data.trail) do
    if data.time - item.t <= data.trail_duration then
      table.insert(alive_trail, item)
    end
  end
  data.trail = alive_trail
end

source_def.video_render = function(data, effect)
  if data == nil or data.effect == nil then return end
  if data.width == nil or data.height == nil or data.width <= 0 or data.height <= 0 then return end

  set_float(data.params.width, data.width)
  set_float(data.params.height, data.height)
  set_float(data.params.time, data.time)
  set_float(data.params.mouse_x, data.mouse_x)
  set_float(data.params.mouse_y, data.mouse_y)
  set_float(data.params.filter_mode, data.is_filter and 1.0 or 0.0)
  set_float(data.params.visual_mode, data.visual_mode)
  set_float(data.params.shape_mode, data.shape_mode)
  set_float(data.params.radius, data.radius)
  set_float(data.params.thickness, data.thickness)
  set_float(data.params.glow, data.glow)
  set_float(data.params.opacity, data.opacity)
  set_float(data.params.idle_activity, data.enable_idle_pulse and data.idle_activity or 0.0)
  set_float(data.params.mode_strength, data.mode_strength)
  set_float(data.params.click_size, data.click_size)
  set_float(data.params.click_duration, data.click_duration)
  set_float(data.params.left_intensity, data.enable_left_click and data.left_intensity or 0.0)
  set_float(data.params.right_intensity, data.enable_right_click and data.right_intensity or 0.0)
  set_float(data.params.speed_active, data.speed_active)
  set_float(data.params.spin_phase, data.spin_phase)
  set_float(data.params.vel_x, data.vel_x)
  set_float(data.params.vel_y, data.vel_y)
  set_float(data.params.motion_ticks, data.enable_motion_ticks and data.motion_ticks or 0.0)
  set_float(data.params.tick_count, data.tick_count)
  set_float(data.params.stretch_strength, data.enable_stretch_warp and data.stretch_strength or 0.0)
  set_float(data.params.wake_strength, data.enable_laser_wake and data.wake_strength or 0.0)
  set_float(data.params.trail_strength, data.enable_comet_trail and data.trail_strength or 0.0)
  set_float(data.params.trail_duration, data.trail_duration)
  set_float(data.params.shake_amount, data.shake_amount)
  set_float(data.params.finder_size, data.finder_size)
  set_float(data.params.main_r, data.main_r)
  set_float(data.params.main_g, data.main_g)
  set_float(data.params.main_b, data.main_b)
  set_float(data.params.accent_r, data.accent_r)
  set_float(data.params.accent_g, data.accent_g)
  set_float(data.params.accent_b, data.accent_b)
  set_float(data.params.left_r, data.left_r)
  set_float(data.params.left_g, data.left_g)
  set_float(data.params.left_b, data.left_b)
  set_float(data.params.right_r, data.right_r)
  set_float(data.params.right_g, data.right_g)
  set_float(data.params.right_b, data.right_b)

  for i = 1, 8 do
    local click = data.clicks[i]
    if click ~= nil then
      set_vec4(data.params["click" .. i], click.x, click.y, data.time - click.t, click.button)
    else
      set_vec4(data.params["click" .. i], -99999.0, -99999.0, 99999.0, 0.0)
    end

    local item = data.trail[i]
    if item ~= nil then
      set_vec4(data.params["trail" .. i], item.x, item.y, data.time - item.t, item.speed)
    else
      set_vec4(data.params["trail" .. i], -99999.0, -99999.0, 99999.0, 0.0)
    end
  end

  if data.is_filter then
    if not obs.obs_source_process_filter_begin(data.source, obs.GS_RGBA, obs.OBS_ALLOW_DIRECT_RENDERING) then
      return
    end
    obs.obs_source_process_filter_tech_end(data.source, data.effect, data.width, data.height, "Draw")
  else
    while obs.gs_effect_loop(data.effect, "Draw") do
      obs.gs_draw_sprite(nil, 0, data.width, data.height)
    end
  end
end

filter_def.get_name = function()
  return "Legends Cursor Filter"
end

filter_def.create = function(settings, source)
  local data = source_def.create(settings, source)
  if data ~= nil then
    data.is_filter = true
  end
  return data
end

filter_def.destroy = source_def.destroy
filter_def.get_defaults = source_def.get_defaults
filter_def.get_properties = source_def.get_properties
filter_def.update = source_def.update
filter_def.get_width = source_def.get_width
filter_def.get_height = source_def.get_height
filter_def.video_tick = source_def.video_tick
filter_def.video_render = source_def.video_render

function script_description()
  return "Legends Cursor: source and filter versions with classic, momentum, comet, stretch, and finder cursor modes."
end

function script_load(settings)
  obs.obs_register_source(source_def)
  obs.obs_register_source(filter_def)
end

EFFECT = [[
#define SamplerState sampler_state
#define Texture2D texture2d

uniform float4x4 ViewProj;
uniform Texture2D image;
uniform float width;
uniform float height;
uniform float time;
uniform float mouse_x;
uniform float mouse_y;
uniform float filter_mode;
uniform float visual_mode;
uniform float shape_mode;
uniform float radius;
uniform float thickness;
uniform float glow;
uniform float opacity;
uniform float idle_activity;
uniform float mode_strength;
uniform float click_size;
uniform float click_duration;
uniform float left_intensity;
uniform float right_intensity;
uniform float speed_active;
uniform float spin_phase;
uniform float vel_x;
uniform float vel_y;
uniform float motion_ticks;
uniform float tick_count;
uniform float stretch_strength;
uniform float wake_strength;
uniform float trail_strength;
uniform float trail_duration;
uniform float shake_amount;
uniform float finder_size;
uniform float main_r;
uniform float main_g;
uniform float main_b;
uniform float accent_r;
uniform float accent_g;
uniform float accent_b;
uniform float left_r;
uniform float left_g;
uniform float left_b;
uniform float right_r;
uniform float right_g;
uniform float right_b;
uniform float4 click1;
uniform float4 click2;
uniform float4 click3;
uniform float4 click4;
uniform float4 click5;
uniform float4 click6;
uniform float4 click7;
uniform float4 click8;
uniform float4 trail1;
uniform float4 trail2;
uniform float4 trail3;
uniform float4 trail4;
uniform float4 trail5;
uniform float4 trail6;
uniform float4 trail7;
uniform float4 trail8;

SamplerState textureSampler {
  Filter = Linear;
  AddressU = Clamp;
  AddressV = Clamp;
};

struct VertIn {
  float4 pos : POSITION;
  float2 uv : TEXCOORD0;
};

struct VertOut {
  float4 pos : POSITION;
  float2 uv : TEXCOORD0;
};

VertOut VSDefault(VertIn v_in)
{
  VertOut v_out;
  v_out.pos = mul(float4(v_in.pos.xyz, 1.0), ViewProj);
  v_out.uv = v_in.uv;
  return v_out;
}

float ring(float d, float r, float w, float aa)
{
  return 1.0 - smoothstep(w, w + aa, abs(d - r));
}

float life(float age, float duration, float power)
{
  if (age < 0.0 || age > duration) return 0.0;
  float t = age / duration;
  return pow(1.0 - t, power);
}

float2 velocity_dir()
{
  float2 v = float2(vel_x, vel_y);
  float mag = max(length(v), 0.0001);
  return v / mag;
}

float shape_distance(float2 p)
{
  if (shape_mode > 0.5 && shape_mode < 1.5) {
    return (abs(p.x) + abs(p.y)) * 0.7071;
  }
  if (shape_mode >= 1.5) {
    float2 q = abs(p);
    return pow(pow(q.x, 4.0) + pow(q.y, 4.0), 0.25);
  }
  return length(p);
}

float2 stretch_space(float2 p)
{
  float stretch_mode = abs(visual_mode - 3.0) < 0.5 ? 1.0 : 0.0;
  float amount = stretch_strength * mode_strength * speed_active * stretch_mode;
  float2 dir = velocity_dir();
  float along = dot(p, dir);
  float2 perp = p - dir * along;
  return dir * (along / (1.0 + amount)) + perp * (1.0 + amount * 0.24);
}

float spoke_burst(float2 p, float age, float size, float phase, float density)
{
  if (age < 0.0 || age > click_duration) return 0.0;
  float t = age / click_duration;
  float d = shape_distance(p);
  float a = atan2(p.y, p.x);
  float spokes = pow(saturate(sin(a * density + phase) * 0.5 + 0.5), 9.0);
  float radial = ring(d, radius + size * (0.15 + 0.85 * t), max(thickness * 0.75, 4.0), 4.0);
  return spokes * radial * pow(1.0 - t, 1.15);
}

float circle_click(float2 p, float age)
{
  if (age < 0.0 || age > click_duration) return 0.0;
  float t = age / click_duration;
  float d = shape_distance(p);
  float r = radius + click_size * t;
  float ripple = ring(d, r, max(thickness * (0.85 + t), 5.0), 4.0);
  float flash = life(age, 0.28, 1.7) * (1.0 - smoothstep(0.0, radius * 0.95, d)) * 0.34;
  return ripple * pow(1.0 - t, 1.22) + flash;
}

float diamond_click(float2 p, float age)
{
  if (age < 0.0 || age > click_duration) return 0.0;
  float t = age / click_duration;
  float d = (abs(p.x) + abs(p.y)) * 0.7071;
  float r = radius * 1.16 + click_size * 0.78 * t;
  float diamond = ring(d, r, max(thickness * (0.90 + t), 5.0), 5.0);
  float cross = 1.0 - smoothstep(thickness * 0.55, thickness * 0.55 + 4.0, min(abs(p.x), abs(p.y)));
  float band = ring(length(p), radius * (1.05 + 0.45 * t), thickness * 1.15, 5.0);
  float flash = life(age, 0.24, 1.5) * (1.0 - smoothstep(0.0, radius * 0.80, length(p))) * 0.30;
  return diamond * pow(1.0 - t, 1.08) + cross * band * pow(1.0 - t, 1.2) + flash;
}

float click_alpha(float2 p, float4 click, out float right_weight)
{
  right_weight = click.w > 1.5 ? 1.0 : 0.0;
  if (click.w <= 0.0 || click.z < 0.0 || click.z > click_duration) return 0.0;
  float2 q = p - click.xy;
  float left = circle_click(q, click.z) + spoke_burst(q, click.z, click_size, spin_phase + time * 3.0, 13.0);
  float right = diamond_click(q, click.z) + spoke_burst(q, click.z, click_size * 0.78, -spin_phase - time * 2.4, 8.0) * 0.75;
  return lerp(left * left_intensity, right * right_intensity, right_weight);
}

float rotating_ticks(float2 p, float d)
{
  float a = atan2(p.y, p.x);
  float tick = pow(saturate(sin(a * max(tick_count, 1.0) + spin_phase) * 0.5 + 0.5), 18.0);
  float momentum_mode = abs(visual_mode - 1.0) < 0.5 ? 1.0 : 0.0;
  float base = 0.18 * idle_activity + speed_active * motion_ticks * (0.50 + momentum_mode * 0.80);
  float band = ring(d, radius * (1.16 + speed_active * 0.24), max(thickness * 0.55, 3.0), 3.0);
  return tick * band * base * mode_strength;
}

float wake_mark(float2 p)
{
  float2 dir = velocity_dir();
  float behind = max(0.0, -dot(p, dir));
  float side = abs(dot(p, float2(-dir.y, dir.x)));
  float body = 1.0 - smoothstep(radius * 0.35, radius * (1.6 + speed_active), behind);
  float narrow = 1.0 - smoothstep(thickness * 1.4, thickness * 1.4 + radius * 0.22, side);
  return body * narrow * speed_active * wake_strength * mode_strength;
}

float trail_mark(float2 p, float4 item)
{
  if (item.w <= 0.0 || item.z < 0.0 || item.z > trail_duration) return 0.0;
  float comet_mode = abs(visual_mode - 2.0) < 0.5 ? 1.0 : 0.0;
  float stretch_mode = abs(visual_mode - 3.0) < 0.5 ? 0.35 : 0.0;
  float t = item.z / max(trail_duration, 0.001);
  float2 q = p - item.xy;
  float d = shape_distance(q);
  float local_radius = radius * (0.68 + item.w * 0.30);
  float mark = ring(d, local_radius, max(thickness * 0.50, 3.0), 4.0);
  return mark * pow(1.0 - t, 1.35) * item.w * trail_strength * mode_strength * max(comet_mode, stretch_mode);
}

float finder_rings(float d)
{
  float manual = abs(visual_mode - 4.0) < 0.5 ? speed_active * 0.26 : 0.0;
  float finder = max(shake_amount, manual) * mode_strength;
  float scaled = radius * lerp(1.0, finder_size, saturate(finder));
  float outer1 = ring(d, scaled, max(thickness * 0.78, 4.0), 5.0);
  float outer2 = ring(d, scaled * 1.34 + sin(time * 7.0) * 9.0, max(thickness * 0.45, 3.0), 6.0);
  return (outer1 * 0.70 + outer2 * 0.38) * saturate(finder);
}

float4 PSDefault(VertOut v_in) : TARGET
{
  float2 p = v_in.uv * float2(width, height);
  float2 m = float2(mouse_x, mouse_y);
  float2 local_p = p - m;
  float2 shaped_p = stretch_space(local_p);
  float d = shape_distance(shaped_p);

  float finder = max(shake_amount, abs(visual_mode - 4.0) < 0.5 ? speed_active * 0.22 : 0.0) * mode_strength;
  float pulse = 1.0 + sin(time * 4.6) * idle_activity * 0.12;
  float r = radius * pulse * lerp(1.0, finder_size, saturate(finder) * 0.35);

  float halo = ring(d, r, thickness, 2.0);
  float haze = (1.0 - smoothstep(r, r + glow, d)) * 0.34;
  float inner = (1.0 - smoothstep(r - thickness * 0.35, r, d)) * 0.10;
  float ticks = rotating_ticks(shaped_p, d);
  float wake = wake_mark(local_p) * (abs(visual_mode) < 0.5 ? 0.20 : 1.0);

  float trail = 0.0;
  trail += trail_mark(p, trail1);
  trail += trail_mark(p, trail2);
  trail += trail_mark(p, trail3);
  trail += trail_mark(p, trail4);
  trail += trail_mark(p, trail5);
  trail += trail_mark(p, trail6);
  trail += trail_mark(p, trail7);
  trail += trail_mark(p, trail8);
  trail = saturate(trail);

  float right_mix = 0.0;
  float rm = 0.0;
  float ca = 0.0;
  float a = 0.0;
  a = click_alpha(p, click1, rm); ca += a; right_mix += a * rm;
  a = click_alpha(p, click2, rm); ca += a; right_mix += a * rm;
  a = click_alpha(p, click3, rm); ca += a; right_mix += a * rm;
  a = click_alpha(p, click4, rm); ca += a; right_mix += a * rm;
  a = click_alpha(p, click5, rm); ca += a; right_mix += a * rm;
  a = click_alpha(p, click6, rm); ca += a; right_mix += a * rm;
  a = click_alpha(p, click7, rm); ca += a; right_mix += a * rm;
  a = click_alpha(p, click8, rm); ca += a; right_mix += a * rm;
  ca = saturate(ca);
  right_mix = ca > 0.001 ? saturate(right_mix / ca) : 0.0;

  float finder_energy = finder_rings(d);
  float3 main_color = float3(main_r, main_g, main_b);
  float3 accent_color = float3(accent_r, accent_g, accent_b);
  float3 left_color = float3(left_r, left_g, left_b);
  float3 right_color = float3(right_r, right_g, right_b);
  float3 click_color = lerp(left_color, right_color, right_mix);

  float base_energy = halo + haze + inner + ticks;
  float accent_energy = trail + wake + finder_energy;
  float main_a = saturate(base_energy * opacity);
  float accent_a = saturate(accent_energy * opacity);
  float click_a = saturate(ca * opacity);
  float3 rgb = main_color * main_a + accent_color * accent_a + click_color * click_a;
  float out_a = saturate(main_a + accent_a + click_a);
  if (filter_mode > 0.5) {
    float4 base = image.Sample(textureSampler, v_in.uv);
    return float4(saturate(base.rgb * 0.0 + rgb * out_a), out_a);
  }
  return float4(rgb, out_a);
}

technique Draw
{
  pass
  {
    vertex_shader = VSDefault(v_in);
    pixel_shader = PSDefault(v_in);
  }
}
]]
