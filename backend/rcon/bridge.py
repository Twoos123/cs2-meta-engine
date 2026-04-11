"""
RCON Bridge — teleports the player to a grenade lineup position in a local CS2 server.

When the user clicks "Practice in Game" the frontend calls POST /api/practice.
This module sends three CS2 console commands via RCON:

    1. setpos  X Y Z           — teleports the player's body
    2. setang  Pitch Yaw 0     — sets the view angle
    3. give    weapon_<type>   — gives the correct grenade

Prerequisites
-------------
- CS2 must be running locally (listen server or local dedicated server).
- Launch option: -netconport 27015 (or the port in config).
- sv_cheats 1 must be active (required for setpos/setang).
- rcon_password must match the server's rcon_password cvar.

Usage
-----
    import asyncio
    from backend.rcon.bridge import RCONBridge

    bridge = RCONBridge()
    result = asyncio.run(bridge.teleport_to_lineup(cluster))
"""
from __future__ import annotations

import asyncio
import logging
from typing import List, Optional, Tuple

from backend.config import settings
from backend.models.schemas import LineupCluster, PracticeResponse

logger = logging.getLogger(__name__)

# Map grenade_type strings to CS2 weapon entity names
GRENADE_GIVE_MAP = {
    "smokegrenade": "weapon_smokegrenade",
    "hegrenade": "weapon_hegrenade",
    "flashbang": "weapon_flashbang",
    "molotov": "weapon_molotov",
    "decoy": "weapon_decoy",
}


class RCONBridge:
    """
    Async RCON client that wraps aiorcon to issue CS2 console commands.
    """

    def __init__(
        self,
        host: Optional[str] = None,
        port: Optional[int] = None,
        password: Optional[str] = None,
    ) -> None:
        self.host = host or settings.rcon_host
        self.port = port or settings.rcon_port
        self.password = password or settings.rcon_password

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def teleport_to_lineup(self, cluster: LineupCluster) -> PracticeResponse:
        """
        Send setpos, setang, and give commands to place the player at the
        lineup throwing position with the correct grenade equipped.
        """
        weapon = GRENADE_GIVE_MAP.get(cluster.grenade_type, "weapon_smokegrenade")

        commands = self._build_commands(
            x=cluster.throw_centroid_x,
            y=cluster.throw_centroid_y,
            z=cluster.throw_centroid_z,
            pitch=cluster.avg_pitch,
            yaw=cluster.avg_yaw,
            weapon=weapon,
        )

        try:
            responses = await self._send_commands(commands)
            logger.info(
                "Teleported to cluster %d on %s — %d commands sent",
                cluster.cluster_id,
                cluster.map_name,
                len(commands),
            )
            return PracticeResponse(success=True, commands_sent=commands)
        except Exception as exc:
            logger.error("RCON error: %s", exc)
            return PracticeResponse(
                success=False,
                commands_sent=commands,
                error=str(exc),
            )

    async def send_raw(self, command: str) -> str:
        """Send a single raw RCON command and return the response string."""
        responses = await self._send_commands([command])
        return responses[0] if responses else ""

    def build_console_string(self, cluster: LineupCluster) -> str:
        """
        Return a single semicolon-separated CS2 console string the user can
        paste into the game console directly (no RCON needed).

        Example output:
            setpos 123.45 678.90 64.00; setang -5.3 182.7 0; give weapon_smokegrenade
        """
        weapon = GRENADE_GIVE_MAP.get(cluster.grenade_type, "weapon_smokegrenade")
        commands = self._build_commands(
            x=cluster.throw_centroid_x,
            y=cluster.throw_centroid_y,
            z=cluster.throw_centroid_z,
            pitch=cluster.avg_pitch,
            yaw=cluster.avg_yaw,
            weapon=weapon,
        )
        return "; ".join(commands)

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _build_commands(
        *,
        x: float,
        y: float,
        z: float,
        pitch: float,
        yaw: float,
        weapon: str,
    ) -> List[str]:
        """Build the ordered list of CS2 console commands."""
        return [
            "sv_cheats 1",
            f"setpos {x:.4f} {y:.4f} {z:.4f}",
            f"setang {pitch:.4f} {yaw:.4f} 0",
            f"give {weapon}",
        ]

    async def _send_commands(self, commands: List[str]) -> List[str]:
        """
        Connect to the CS2 RCON server and send commands sequentially.
        Uses aiorcon under the hood.
        """
        try:
            import aiorcon  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "aiorcon is not installed. Run: pip install aiorcon"
            ) from exc

        loop = asyncio.get_event_loop()
        responses: List[str] = []

        # aiorcon API: RCON(host, port, password, loop)
        conn = await aiorcon.RCON.create(
            self.host,
            self.port,
            self.password,
            loop,
            auto_reconnect_attempts=3,
        )

        try:
            for cmd in commands:
                logger.debug("RCON → %s", cmd)
                resp = await conn(cmd)
                responses.append(str(resp))
                await asyncio.sleep(0.05)  # tiny gap between commands
        finally:
            conn.close()

        return responses


# ---------------------------------------------------------------------------
# Command Generator (standalone utility — no RCON required)
# ---------------------------------------------------------------------------

def generate_console_string(cluster: LineupCluster) -> str:
    """
    Module-level convenience wrapper so you can import this function directly.

        from backend.rcon.bridge import generate_console_string
        print(generate_console_string(my_cluster))
    """
    bridge = RCONBridge()
    return bridge.build_console_string(cluster)
