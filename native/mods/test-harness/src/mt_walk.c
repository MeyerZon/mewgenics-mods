/* mt_walk.c — the pure half of the campaign walk (run travel <type>): the map node type names and a breadth-first
 * search over a map's "next" edges. The glue (mewtest.c) copies the live MapScreen's nodes into index arrays
 * (MapScreen+OFF_MAPSCREEN_NODES, MapNode+OFF_MAPNODE_TYPE / OFF_MAPNODE_NEXT_*) and calls mt_walk_nearest; nothing
 * here reads game memory. Contracts: docs/ingame-testing.md "Campaign walk". */
#include <string.h>
#include "mt_pure.h"

/* MapNode::str_to_type 0x225680 (MapNode_type_225680_0x225680.c): the 19 names in enum order */
static const char *const NODE_TYPES[MT_NODE_TYPE_COUNT] = {
    "none", "npc", "enter", "exit", "home", "battle", "hard", "miniboss", "boss", "event", "optional_event",
    "special_event", "shop", "treasure", "furniturebox", "foodbox", "bonus", "empty", "any",
};

int mt_node_type_id(const char *name, size_t n) {
    if (!name) return -1;
    for (int i = 0; i < MT_NODE_TYPE_COUNT; i++)
        if (strlen(NODE_TYPES[i]) == n && strncmp(NODE_TYPES[i], name, n) == 0) return i;
    return -1;
}

const char *mt_node_type_name(int id) { return id >= 0 && id < MT_NODE_TYPE_COUNT ? NODE_TYPES[id] : "?"; }

int mt_walk_nearest(int n, const int *type, const int *adjStart, const int *adj, int start, int want, int *depthOut) {
    static int queue[MT_WALK_MAX_NODES], depth[MT_WALK_MAX_NODES];
    if (depthOut) *depthOut = -1;
    if (n <= 0 || n > MT_WALK_MAX_NODES || !type || !adjStart || !adj || start < 0 || start >= n) return -1;
    for (int i = 0; i < n; i++) depth[i] = -1;
    int head = 0, tail = 0;
    depth[start] = 0;
    queue[tail++] = start;
    while (head < tail) {
        int cur = queue[head++];
        for (int k = adjStart[cur]; k < adjStart[cur + 1]; k++) {
            int nx = adj[k];
            if (nx < 0 || nx >= n || depth[nx] >= 0) continue;   /* out-of-range edges are ignored; cycles end here */
            depth[nx] = depth[cur] + 1;
            if (type[nx] == want) { if (depthOut) *depthOut = depth[nx]; return nx; }
            queue[tail++] = nx;
        }
    }
    return -1;
}

const char *mt_run_op_name(int op) {
    return op == MT_RUN_START ? "start" : op == MT_RUN_TRAVEL ? "travel" : op == MT_RUN_FIGHT ? "fight" : "?";
}
