/** @type {import('next').NextConfig} */

/**
 * `LOW_MEMORY_DEV=1 npm run dev` shrinks the dev server's compile worker pool
 * to a single process.
 *
 * Next spawns a worker per CPU to compile routes in parallel, and on a machine
 * that is already short of free RAM those forks fail with "Jest worker
 * encountered N child process exceptions, exceeding retry limit" — which
 * surfaces as a Server Error on the page rather than as an obvious
 * out-of-memory message. One worker compiles more slowly but has a much
 * smaller peak footprint.
 *
 * Off unless the flag is set, so normal dev and every build are untouched.
 */
const lowMemory = process.env.LOW_MEMORY_DEV === "1"

const nextConfig = {
  ...(lowMemory ? { experimental: { cpus: 1, workerThreads: false } } : {}),
}

export default nextConfig
