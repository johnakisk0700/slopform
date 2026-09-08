-- Return 1 when a slot is acquired, or 0 when all slots are occupied.
local slotsKey = KEYS[1]
local concurrencyLimit = tonumber(ARGV[1])
local leaseMs = tonumber(ARGV[2])
local token = ARGV[3]

local time = redis.call("TIME")
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

-- Recover slots left behind by workers that stopped without releasing them.
redis.call("ZREMRANGEBYSCORE", slotsKey, "-inf", nowMs)
if redis.call("ZCARD", slotsKey) >= concurrencyLimit then
  return 0
end

redis.call("ZADD", slotsKey, nowMs + leaseMs, token)
redis.call("PEXPIRE", slotsKey, leaseMs)
return 1
