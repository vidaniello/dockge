import os from "os";
import { DockgeServer } from "../dockge-server";
import { ValidationError } from "../util-server";
import { apiName, dockerApiGet } from "../docker-api";
import { getStorageStatus } from "./storage";
import { mountsInside, readMountInfo } from "./mountinfo";

/**
 * The stacks folder is a plain folder inside a dataset (docs/ZFS-DESIGN.md §5.1). Dockge cannot convert it itself (it
 * runs on it): it writes a script to paste into the shell of TrueNAS (as root) that stops the stacks and Dockge, moves
 * the folder aside, creates the dataset with the TrueNAS API (midclt), copies the content back, verifies and starts
 * everything again. The original copy is kept.
 */

function shellQuote(value : string) : string {
    return "'" + value.replace(/'/g, "'\\''") + "'";
}

export async function stacksFolderScript(server : DockgeServer) : Promise<{ script : string, dataset : string, container : string }> {
    const status = await getStorageStatus(server);
    if (!status.zfs || status.stacksIsDatasetRoot || !status.stacksFolderDataset || !status.dataset) {
        throw new ValidationError("The stacks folder is not a plain folder inside a dataset: nothing to do");
    }
    const subPath = status.stacksFolderDataset.slice(status.dataset.length + 1);
    if (subPath.includes("/")) {
        throw new ValidationError(`The stacks folder is ${subPath} inside ${status.dataset}: the folders between them would have to become datasets too. Move it by hand, or move the stacks folder directly under a dataset.`);
    }
    if (mountsInside(readMountInfo(), status.stacksDir).some((entry) => entry.mountPoint !== status.stacksDir)) {
        throw new ValidationError("Datasets are mounted inside the stacks folder: move it by hand");
    }

    let container = "dockge";
    try {
        const inspect = await dockerApiGet<{ Name? : string }>(`/containers/${apiName(os.hostname())}/json`);
        if (inspect.Name) {
            container = inspect.Name.replace(/^\//, "");
        }
    } catch (e) {
        // keep the default name: the user can change it in the script
    }

    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const create = JSON.stringify({
        name: status.stacksFolderDataset,
        share_type: "GENERIC",
    });
    const script = `#!/bin/bash
# Moves the stacks folder of Dockge into its own dataset. Run it in the shell of TrueNAS as root (sudo -i).
# It assumes Dockge sees the stacks folder at the same path as the host (as Dockge requires).
set -euo pipefail

STACKS=${shellQuote(status.stacksDir)}
DATASET=${shellQuote(status.stacksFolderDataset)}
BACKUP="$STACKS.dockge-backup-${stamp}"
DOCKGE=${shellQuote(container)}   # name of the Dockge container

running=()
echo "== Stopping the stacks and Dockge"
for dir in "$STACKS"/*/; do
    for file in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
        if [ -f "$dir$file" ]; then
            if [ -n "$(cd "$dir" && docker compose ps -q --status running)" ]; then
                running+=("$dir")
            fi
            (cd "$dir" && docker compose stop)
            break
        fi
    done
done
docker stop "$DOCKGE"

echo "== Moving $STACKS to $BACKUP"
mv "$STACKS" "$BACKUP"

echo "== Creating the dataset $DATASET"
midclt call pool.dataset.create ${shellQuote(create)} > /dev/null
for i in $(seq 1 30); do mountpoint -q "$STACKS" && break; sleep 1; done
mountpoint -q "$STACKS" || { echo "The dataset is not mounted at $STACKS: stopping. The stacks are in $BACKUP"; exit 1; }

echo "== Copying (owners, permissions, ACLs and links are kept)"
cp -a --reflink=auto "$BACKUP/." "$STACKS/"

echo "== Verifying"
a=$(cd "$BACKUP" && find . | wc -l); b=$(cd "$STACKS" && find . -path ./.zfs -prune -o -print | wc -l)
if [ "$a" != "$b" ]; then echo "The copy differs ($a / $b entries): stopping. The original is in $BACKUP"; exit 1; fi

echo "== Starting Dockge and the stacks that were running"
docker start "$DOCKGE"
for dir in "\${running[@]}"; do (cd "$dir" && docker compose start); done

echo "Done. If the stacks work, delete the copy: rm -rf \\"$BACKUP\\""
echo "Remember: the stacks folder must be mounted into Dockge with bind propagation rslave (Settings -> Storage)."
`;
    return {
        script,
        dataset: status.stacksFolderDataset,
        container,
    };
}
