import os from 'node:os';
import process from 'node:process';

export class SystemMonitor {
    constructor(intervalMs = 10000) {
        this.intervalMs = intervalMs;
        this.staticInfo = this.readStaticInfo();
        this.cachedStats = null;
        this.lastUpdate = 0;
        this.prevCpus = os.cpus();
        this.updateStats(); // Initial update
    }

    getStaticInfo() {
        return this.staticInfo;
    }

    getStats() {
        const now = Date.now();
        if (now - this.lastUpdate > this.intervalMs) {
            this.updateStats();
        }
        // Always update uptimes as they are cheap and should be accurate
        if (this.cachedStats) {
            this.cachedStats.uptime = os.uptime();
            this.cachedStats.processUptime = process.uptime();
        }
        return this.cachedStats;
    }

    readStaticInfo() {
        const cpus = os.cpus();
        const totalMem = os.totalmem();

        const nets = os.networkInterfaces();
        let ip = 'Unknown';
        // Find first non-internal IPv4
        for (const name of Object.keys(nets)) {
            for (const net of nets[name]) {
                if (net.family === 'IPv4' && !net.internal) {
                    ip = net.address;
                    break;
                }
            }
            if (ip !== 'Unknown') break;
        }

        return {
            hostname: os.hostname(),
            osName: `${os.type()} ${os.release()}`, // e.g. Darwin 21.6.0
            ip,
            cpu: {
                model: cpus[0]?.model || 'Unknown CPU',
                count: cpus.length
            },
            memory: {
                total: totalMem
            }
        };
    }

    updateStats() {
        const cpus = os.cpus();
        
        // Calculate CPU usage percentage
        let totalIdle = 0;
        let totalTick = 0;
        
        for (let i = 0; i < cpus.length; i++) {
            const cpu = cpus[i];
            const prevCpu = this.prevCpus[i];
            
            // Calculate delta for this core
            let idle = cpu.times.idle;
            let total = 0;
            for (const type in cpu.times) {
                total += cpu.times[type];
            }
            
            let prevIdle = 0;
            let prevTotal = 0;
            if (prevCpu) {
                prevIdle = prevCpu.times.idle;
                for (const type in prevCpu.times) {
                    prevTotal += prevCpu.times[type];
                }
            }
            
            totalIdle += (idle - prevIdle);
            totalTick += (total - prevTotal);
        }
        
        this.prevCpus = cpus;
        
        const idlePercent = totalTick > 0 ? totalIdle / totalTick : 0;
        const usagePercent = (1 - idlePercent) * 100;

        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;

        const speeds = cpus.map(c => c.speed);
        const minSpeed = Math.min(...speeds);
        const maxSpeed = Math.max(...speeds);
        const speedStr = minSpeed === maxSpeed 
            ? `${(minSpeed / 1000).toFixed(1)}GHz`
            : `${(minSpeed / 1000).toFixed(1)}GHz-${(maxSpeed / 1000).toFixed(1)}GHz`;

        this.cachedStats = {
            cpu: {
                speed: speedStr,
                usagePercent: usagePercent.toFixed(1)
            },
            memory: {
                free: freeMem,
                used: usedMem
            },
            uptime: os.uptime(),
            processUptime: process.uptime()
        };
        this.lastUpdate = Date.now();
    }
}
