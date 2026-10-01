<template>
  <div class="card">
    <div class="admin-section-title">
      <div class="section-dot" style="background: var(--blue);"></div>
      Fleet Inventory
    </div>

    <EmptyState v-if="trucks.length === 0">No trucks yet.</EmptyState>

    <table v-else class="truck-table">
      <thead>
        <!-- COLUMN BUDGET — measured in a real browser with the real webfonts
             loaded, against origin/main as a baseline. The figures that decide
             clipping are min-content floors, not the widths this first read:
               main      floor  998.4px   (VIN alone: 140.4px, the widest column —
                                           an unbreakable 17-char mono token)
               shipped   floor  928.3px   (VIN 57.5, Tank 61.5)
             Tank costs +61.5px of floor; VIN last-6 saves -82.9px; folding Year
             into Vehicle saves -48.8px. Net -70.1px vs main.

             Available table width = viewport - 346px (240 sidebar + 64 .main
             padding + 40 .card padding + 2 border), so 1440 -> 1094px and
             1280 -> 934px.

             THE VIN SHORTENING IS LOAD-BEARING, not cosmetic. Measured
             counterfactual (Tank added, full VIN restored): floor 1011.2px,
             which clips 77px at 1280 — WORSE than main. Tank does not fit
             without it.

             At 1280 main clips 64px and cuts off the Remove button; shipped
             clips 0. This grid fixes a pre-existing bug rather than causing one.
             The remaining cost is one extra text line on one row per width.

             ⚠️ Headroom at 1280 is 5.7px (928.3 floor vs 934 available). One
             longer owner name, driver name or a 4-digit tank tips it into
             clipping. If you need room, the fattest floors left are the actions
             column (129.8px) and Routemate (86px).

             ODOMETER IS DELIBERATELY NOT A COLUMN HERE — it lives in the row's
             detail modal instead. A column would cost roughly 80-95px of floor
             ("ODOMETER" header ≈ 80px; a "992,938 mi" mono cell ≈ 95px) against
             5.7px of headroom, i.e. ~14x over budget, and unlike the Tank
             column there is nothing left to shorten to pay for it — the VIN
             trick above was already spent. Adding it would clip ~75-90px at
             1280 and cut the Remove button off again, reintroducing the exact
             bug this grid was built to fix. See the Odometer row in the view
             modal below.

             ⚠️ Verifying this: probe .card, NOT the table. table.scrollWidth -
             clientWidth reads 0 at every width on both builds — the table box
             grows instead of scrolling and .card{overflow:hidden} swallows it
             silently. -->
        <tr>
          <th>Unit #</th>
          <th>Vehicle</th>
          <th>VIN</th>
          <th>Plate</th>
          <th>Status</th>
          <th>Current Driver</th>
          <th>Driver Pay</th>
          <th title="Usable diesel capacity. Drives the fuel-range estimate drivers see; blank falls back to 200 gal.">Tank</th>
          <th>Loads</th>
          <th>Routemate</th>
          <th v-if="showOwner">Owner</th>
          <th v-if="canEdit"></th>
        </tr>
      </thead>
      <tbody>
        <template v-for="truck in trucks" :key="truck.id">
          <tr class="clickable-row" @click="viewTruck = truck">
            <td class="unit-number">{{ truck.UnitNumber }}</td>
            <td>{{ vehicleLabel(truck) }}</td>
            <!-- Last 6, full VIN on hover + in the row's detail modal. Same short-VIN
                 convention the investor MyTrucks table already uses, and it is what
                 actually pays for the Tank column: the full 17 chars are worth
                 ~76px in a grid already ~200px past its budget at 1440. -->
            <td class="vin-cell" :title="truck.VIN || ''">{{ shortVin(truck.VIN) }}</td>
            <td>{{ truck.LicensePlate || '\u2014' }}</td>
            <td>
              <span :class="['status-badge', statusClass(truck.Status)]">{{ truck.Status }}</span>
              <div v-if="needsFixedCostSetup(truck)" style="margin-top:0.3rem;">
                <span
                  class="cost-warning-badge"
                  :title="fixedCostSetupHint"
                >No fixed costs configured</span>
              </div>
            </td>
            <td :style="{ color: truck.AssignedDriver ? 'var(--text)' : 'var(--text-dim)' }">
              {{ truck.AssignedDriver || '\u2014' }}
            </td>
            <td class="mono">
              <span v-if="truck.DriverPayDaily > 0">${{ truck.DriverPayDaily }}/day</span>
              <span v-else class="pay-default" title="No custom rate set; pay calculations use the $250/day default">$250/day default</span>
            </td>
            <td class="mono">
              <span v-if="tankGallons(truck)">{{ tankGallons(truck) }} gal</span>
              <span
                v-else
                class="tank-default"
                title="No tank size recorded — the fuel-range estimate falls back to 200 gal, which overstates a driver's remaining miles on any smaller tank. Set the real capacity via Edit → Fuel Tank, MPG &amp; Business Configuration."
              >200 gal (default)</span>
            </td>
            <td class="mono">{{ truck.LoadCount ?? 0 }}</td>
            <td>
              <span
                v-if="truck.RoutemateVehicleId"
                class="rm-linked"
                :title="linkedTitle(truck)"
              ><span :class="['rm-dot', { 'rm-dot-silent': truck.EldSilent }]"></span>Linked</span>
              <button
                v-else-if="canEdit"
                class="btn-link-rm"
                @click.stop="openLinkModal(truck)"
              >Link</button>
              <span v-else class="rm-unlinked">&mdash;</span>
              <button
                v-if="truck.RoutemateVehicleId && canEdit"
                class="btn-unlink-rm"
                title="Clear the Routemate device link"
                :aria-label="`Unlink the ELD device from ${truck.UnitNumber || 'this truck'}`"
                @click.stop="handleUnlink(truck)"
              >&times;</button>
              <!-- A link to a device that has stopped reporting looks exactly like
                   a working one without this: the chip below says how long it has
                   been quiet, and Change re-points the link without unlinking
                   first. The server decides "silent" (EldSilent); nothing here
                   re-derives the threshold. -->
              <div v-if="truck.RoutemateVehicleId && (truck.EldSilent || canEdit)" class="rm-cell-extra">
                <span
                  v-if="truck.EldSilent"
                  class="rm-silent-badge"
                  :title="silentTitle(truck.EldLastFixMs)"
                >{{ silentChipText(truck.EldLastFixMs) }}</span>
                <button
                  v-if="canEdit"
                  class="btn-change-rm"
                  :aria-label="`Change the ELD device linked to ${truck.UnitNumber || 'this truck'}`"
                  @click.stop="openLinkModal(truck)"
                >Change</button>
              </div>
            </td>
            <td v-if="showOwner" :style="{ color: truck.OwnerId ? 'var(--text)' : 'var(--text-dim)' }">
              {{ ownerName(truck.OwnerId) }}
            </td>
            <td v-if="canEdit" style="text-align: right;">
              <div class="action-btns">
                <button class="btn-edit" @click.stop="openEdit(truck)">Edit</button>
                <button class="btn-remove" @click.stop="confirmDelete(truck)">Remove</button>
              </div>
            </td>
          </tr>
          <!-- A refused unlink (409 PERIOD_FINALIZED when a finalized month
               carries this truck's loads, or any other failure) in the server's
               own words, directly under the row whose × was clicked. It used to
               reach only the console, so the × looked like it did nothing. -->
          <tr v-if="unlinkError && unlinkError.truckId === truck.id" class="rm-error-row">
            <td :colspan="columnCount">
              <div class="rm-pick-error rm-unlink-error" role="alert">
                <span>{{ unlinkError.message }}</span>
                <button
                  type="button"
                  class="rm-error-dismiss"
                  aria-label="Dismiss this message"
                  @click="unlinkError = null"
                >&times;</button>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>

    <!-- Routemate link modal \u2014 picks an unlinked Routemate vehicle to bind
         to a LogisX truck. Auto-match-by-VIN tries an exact VIN match first
         and is the fast path when both records carry the same VIN. -->
    <Teleport to="body">
      <div v-if="showLinkRm" class="confirm-overlay" @click.self="closeLinkModal">
        <div class="confirm-dialog" style="max-width:560px;">
          <h3 v-if="repointing">Change ELD device for {{ linkTruck.UnitNumber || 'this truck' }}</h3>
          <h3 v-else>Link Truck {{ linkTruck?.UnitNumber || '' }} to an ELD device</h3>
          <p style="font-size:0.78rem;color:var(--text-dim);margin-bottom:0.85rem;">
            Pick a device from the company inventory. After linking, live GPS,
            fault codes, and fuel data flow against this truck.
          </p>

          <div v-if="repointing" class="rm-current">
            <div class="rm-current-label">Current device</div>
            <div class="rm-pick-line1">
              <span class="rm-pick-id">{{ eldVehicleNumber(linkTruck) || linkTruck.RoutemateVehicleId }}</span>
              <span
                v-if="providerLabel(linkTruck.EldProvider)"
                :class="['rm-provider', providerClass(linkTruck.EldProvider)]"
              >{{ providerLabel(linkTruck.EldProvider) }}</span>
            </div>
            <div
              v-if="fixLine(linkTruck.EldLastFixMs, linkTruck.EldSilent)"
              :class="['rm-pick-fix', { warn: linkTruck.EldSilent }]"
            >{{ fixLine(linkTruck.EldLastFixMs, linkTruck.EldSilent) }}</div>
            <div class="rm-current-note">Linking another device replaces this one.</div>
          </div>

          <div v-if="linkTruck && linkTruck.VIN" style="margin-bottom:0.75rem;">
            <button
              class="btn btn-primary"
              :disabled="linkBusy || noVinData"
              :title="noVinData
                ? 'Routemate has not sent a VIN for any device yet \u2014 run Sync in Admin Tools first. Pick the device below instead.'
                : `Match this truck to the Routemate device with VIN ${linkTruck.VIN}`"
              @click="handleAutoLink"
            >Auto-match by VIN ({{ linkTruck.VIN }})</button>
            <!-- Auto-match failure renders HERE, beside the button that caused
                 it, so the picker below survives. It used to share a slot with
                 the list and wiped it out. -->
            <div v-if="autoError" class="rm-auto-error">{{ autoError }}</div>
            <div v-else-if="noVinData" class="rm-auto-note">
              Routemate hasn't reported a VIN for any device yet, so auto-match can't run.
              Pick the device below, or run Sync in Admin Tools first.
            </div>
          </div>

          <div v-if="linkLoading" class="rm-pick-empty">Loading Routemate vehicles...</div>
          <div v-else-if="linkError" class="rm-pick-error">{{ linkError }}</div>
          <div v-else-if="unlinkedVehicles.length === 0" class="rm-pick-empty">
            No unlinked Routemate vehicles available. Run sync from Admin Tools to refresh.
          </div>
          <!-- Served order, never re-sorted here: the server puts devices that
               are reporting first, newest fix first, so a dead device cannot
               sit at the top of the list looking like any other. One choice
               from many, so each item is a label over a visually hidden radio:
               Tab reaches the group, the arrow keys move the pick. Spans
               inside, as a label may only hold phrasing content. -->
          <div v-else class="rm-pick-list" role="radiogroup" aria-label="Devices">
            <label
              v-for="rv in unlinkedVehicles"
              :key="rv.routemate_vehicle_id"
              :class="['rm-pick-item', {
                selected: pickedRoutemateId === rv.routemate_vehicle_id,
                suggested: suggestedId === rv.routemate_vehicle_id,
                silent: rv.silent,
              }]"
            >
              <input
                type="radio"
                name="rm-pick"
                class="rm-pick-radio"
                :value="rv.routemate_vehicle_id"
                :checked="pickedRoutemateId === rv.routemate_vehicle_id"
                @change="pickDevice(rv.routemate_vehicle_id)"
              />
              <span class="rm-pick-line1">
                <span class="rm-pick-id">{{ rv.vehicle_id || rv.routemate_vehicle_id }}</span>
                <span
                  v-if="providerLabel(rv.provider)"
                  :class="['rm-provider', providerClass(rv.provider)]"
                >{{ providerLabel(rv.provider) }}</span>
                <span v-if="rv.vin" class="rm-pick-vin">VIN {{ rv.vin }}</span>
              </span>
              <span class="rm-pick-line2">
                {{ [rv.year, rv.make, rv.model].filter(Boolean).join(' ') || '\u2014' }}
                <span v-if="rv.eld_id" class="rm-pick-eld">ELD {{ rv.eld_id }}</span>
              </span>
              <span
                v-if="fixLine(rv.last_fix_ms, rv.silent)"
                :class="['rm-pick-fix', { warn: rv.silent }]"
              >{{ fixLine(rv.last_fix_ms, rv.silent) }}</span>
              <span v-if="suggestedId === rv.routemate_vehicle_id" class="rm-pick-suggest">
                Likely match for {{ linkTruck?.UnitNumber || 'this truck' }} &mdash; confirm with Link Selected
              </span>
            </label>
          </div>

          <!-- The server refuses a device that has stopped reporting until the
               admin says so (409 ELD_DEVICE_SILENT); its own words go here, with
               the one button that resends the same request confirmed. Focused
               when it appears, not its button, so a second Enter cannot link. -->
          <div
            v-if="silentPrompt"
            ref="silentPromptEl"
            class="rm-silent-prompt"
            role="alert"
            tabindex="-1"
          >
            <div>{{ silentPrompt.error }}</div>
            <button
              type="button"
              class="btn-link-anyway"
              :disabled="linkBusy"
              @click="handleLinkAnyway"
            >{{ linkBusy ? 'Linking...' : 'Link anyway' }}</button>
          </div>

          <div class="confirm-actions">
            <button class="btn btn-secondary" :disabled="linkBusy" @click="closeLinkModal">Cancel</button>
            <button
              class="btn btn-primary"
              :disabled="!pickedRoutemateId || linkBusy"
              @click="handleLink"
            >{{ linkBusy ? 'Linking...' : 'Link Selected' }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Edit Modal -->
    <Teleport to="body">
      <div v-if="showEdit" class="confirm-overlay" @click.self="closeEdit">
        <div ref="editDialogEl" class="confirm-dialog edit-dialog" @change.capture="keepUnreadableNumber">
          <h3>Edit Truck &mdash; {{ editForm.unitNumber }}</h3>

          <!-- Disabled while a save is in flight: anything typed meanwhile would
               be missing from the save already sent, and then shown as saved. -->
          <fieldset class="edit-fields" :disabled="editSaving">
          <div class="edit-field">
            <label>Unit Number</label>
            <input v-model="editForm.unitNumber" type="text" />
          </div>

          <div class="edit-row">
            <div class="edit-field">
              <label>Make</label>
              <select v-model="editForm.make">
                <option value="">-- Select --</option>
                <option v-for="m in truckMakes" :key="m" :value="m">{{ m }}</option>
              </select>
            </div>
            <div class="edit-field">
              <label>Model</label>
              <select v-model="editForm.model" :disabled="!editForm.make">
                <option value="">{{ editForm.make ? '-- Select model --' : '-- Select make first --' }}</option>
                <option v-for="m in editModelOptions" :key="m" :value="m">{{ m }}</option>
              </select>
            </div>
          </div>

          <div class="edit-row">
            <div class="edit-field">
              <label>Year</label>
              <input v-model="editForm.year" type="number" />
            </div>
            <div class="edit-field">
              <label>License Plate</label>
              <input v-model="editForm.licensePlate" type="text" />
            </div>
          </div>

          <div class="edit-field">
            <label>VIN</label>
            <input v-model="editForm.vin" type="text" />
          </div>

          <div class="edit-row">
            <div class="edit-field">
              <label>Status</label>
              <select v-model="editForm.status">
                <option>Active</option>
                <option>Inactive</option>
                <option>Maintenance</option>
                <option>OOS</option>
              </select>
            </div>
            <div class="edit-field">
              <label>Assigned Driver</label>
              <select v-model="editForm.assignedDriver">
                <option value="">None</option>
                <option v-for="name in driverNames" :key="name" :value="name">{{ name }}</option>
              </select>
            </div>
          </div>

          <div class="edit-field">
            <label>Driver Pay ($/day)</label>
            <!-- Pay is Super Admin only (403 PAY_EDIT_ADMIN_ONLY otherwise): shown
                 to everyone who can edit the truck, editable only by them. -->
            <input v-model.number="editForm.driverPayDaily" type="number" min="0" :max="AMOUNT_CAPS.driverPayDaily" step="any" placeholder="250 (default)" :disabled="!canEditPay" />
            <div v-if="canEditPay" class="field-hint">Daily rate paid to this truck's driver (used by invoices, financials, and the investor P&amp;L). Leave blank to use the $250/day default.</div>
            <div v-else class="field-hint">Only a Super Admin can change driver pay.</div>
          </div>

          <div v-if="showOwner" class="edit-field">
            <label>Owner (Investor)</label>
            <select v-model="editForm.ownerId">
              <option :value="0">Unassigned</option>
              <option v-for="inv in investorUsers" :key="inv.id" :value="inv.id">{{ inv.username }}</option>
            </select>
          </div>

          <div class="edit-field">
            <label>Notes</label>
            <textarea v-model="editForm.notes" rows="2"></textarea>
          </div>

          <div class="edit-field">
            <label>Truck Photo</label>
            <!-- Same treatment as AddTruckForm: a bare <input type="file"> with
                 no chrome of its own, so the dashed box is a clean swap. The
                 extension tokens matter because a drop bypasses `accept`
                 entirely, so this validation is the only type gate. -->
            <!-- Not a form control, so the fieldset cannot disable it. -->
            <FileDropZone
              compact
              accept="image/*,.heic,.heif"
              :max-size-mb="10"
              :busy="editPhotoBusy"
              :disabled="editSaving"
              label="Drop a truck photo"
              busy-label="Reading photo…"
              busy-hint="Resizing it before upload"
              @files="onEditPhoto"
            />
            <div v-if="editPhotoError" class="field-hint" style="color:var(--danger);">{{ editPhotoError }}</div>
            <img v-if="editForm.photo" :src="editForm.photo" alt="Truck photo preview" style="max-height:80px;border-radius:6px;margin-top:0.4rem;" />
          </div>

          <details style="margin-bottom:0.75rem;" open>
            <!-- Named after the fields inside it, not the abstraction: the old
                 "Business Configuration" gave no hint it held the fuel tank, so
                 two trucks ran for months on the 200-gal default and drivers
                 were shown ~2.5x their real range. Tank + MPG lead the section
                 for the same reason. -->
            <summary style="font-size:0.72rem;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.04em;cursor:pointer;margin-bottom:0.5rem;">Fuel Tank, MPG &amp; Business Configuration</summary>
            <div class="edit-row">
              <div class="edit-field">
                <label>Fuel Tank (gallons)</label>
                <input v-model.number="editForm.fuelTankGallons" type="number" min="0" :max="AMOUNT_CAPS.fuelTankGallons" step="any" placeholder="200 (default)" />
                <div class="field-hint">Diesel capacity for the Live Tracking fuel-range estimate. Blank = 200 gal default.</div>
              </div>
              <div class="edit-field">
                <label>Avg MPG</label>
                <input v-model.number="editForm.avgMpg" type="number" min="0" :max="AMOUNT_CAPS.avgMpg" step="any" placeholder="6.5 (default)" />
                <div class="field-hint">Blank auto-derives MPG from ELD fuel + odometer.</div>
              </div>
            </div>
            <div class="edit-row">
              <div class="edit-field">
                <label>Purchase Price ($)</label>
                <input v-model.number="editForm.purchasePrice" type="number" min="0" />
              </div>
              <div class="edit-field">
                <label>Title Status</label>
                <select v-model="editForm.titleStatus" style="width:100%;padding:0.4rem 0.5rem;border:1px solid var(--border);border-radius:6px;font-size:0.82rem;">
                  <option value="Clean">Clean</option>
                  <option value="Lien">Lien</option>
                </select>
              </div>
            </div>
            <div class="edit-row">
              <div class="edit-field">
                <label>Maintenance Fund ($/mo)</label>
                <input v-model.number="editForm.maintenanceFundMonthly" type="number" min="0" />
              </div>
            </div>
            <div class="edit-field">
              <label for="edit-truck-in-service-date">In Service Since</label>
              <input id="edit-truck-in-service-date" v-model="editForm.inServiceDate" type="date" />
              <div class="field-hint">Fixed costs below are billed from this month onward. Leave blank to fall back to the date the truck record was created.</div>
            </div>
            <div class="edit-field">
              <label for="edit-truck-retired-at">Retired On</label>
              <input id="edit-truck-retired-at" v-model="editForm.retiredAt" type="date" />
              <div class="field-hint">Stops the fixed costs below. The retirement month is billed in full, so set the date the truck actually left the fleet. Leave blank while it is still in service. Backdating into a closed accounting month is refused.</div>
            </div>
            <div class="edit-row">
              <div class="edit-field">
                <label>Insurance ($/mo)</label>
                <input v-model.number="editForm.insuranceMonthly" type="number" min="0" />
              </div>
              <div class="edit-field">
                <label>ELD ($/mo)</label>
                <input v-model.number="editForm.eldMonthly" type="number" min="0" />
              </div>
            </div>
            <div class="edit-row">
              <div class="edit-field">
                <label>HVUT ($/yr)</label>
                <input v-model.number="editForm.hvutAnnual" type="number" min="0" />
              </div>
              <div class="edit-field">
                <label>IRP ($/yr)</label>
                <input v-model.number="editForm.irpAnnual" type="number" min="0" />
              </div>
            </div>
            <div class="edit-row">
              <div class="edit-field">
                <label>Truck Payment ($/mo)</label>
                <input v-model.number="editForm.truckPaymentMonthly" type="number" min="0" />
              </div>
              <div class="edit-field">
                <label>Admin Fee (%)</label>
                <input v-model.number="editForm.adminFeePct" type="number" min="0" :max="AMOUNT_CAPS.adminFeePct" />
              </div>
            </div>
          </details>
          </fieldset>

          <!-- Directly above Save: the dialog scrolls, so a message up by the
               field could sit off screen while Save seemed to do nothing. A
               deleted truck leaves nothing to save, so it outranks the rest. -->
          <div v-if="editTruckDeleted" class="edit-error" role="alert">This truck has been deleted, so these changes can't be saved.</div>
          <template v-else>
            <!-- Save sends only the fields changed here, so theirs are kept. -->
            <div v-if="editChangedUnderneath" class="edit-note" role="alert">Someone else updated this truck while you were editing — your changes will be saved on top of theirs.</div>
            <div v-if="editError" class="edit-error" role="alert">{{ editError }}</div>
          </template>

          <!-- Save waits for a photo still being read, or it would send the old
               one. Cancel waits for a save in flight: the PUT cannot be called
               back, and closing would drop the form a refusal is shown against. -->
          <div class="confirm-actions">
            <button class="btn btn-secondary" :disabled="editSaving" @click="closeEdit">Cancel</button>
            <button ref="editSaveBtn" class="btn btn-primary" :disabled="editSaving || editPhotoBusy || editTruckDeleted" @click="handleSaveEdit">{{ editSaving ? 'Saving…' : 'Save' }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <ConfirmModal
      :open="showConfirm"
      title="Delete Truck"
      :message="`Delete truck '${pendingTruck?.UnitNumber || ''}'? This action cannot be undone.`"
      confirm-text="Delete"
      :danger="true"
      @confirm="handleConfirmDelete"
      @cancel="showConfirm = false"
    />

    <!-- View Truck Detail Modal -->
    <Teleport to="body">
    <div v-if="viewTruck" style="position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:9999" @click.self="viewTruck = null">
      <div style="background:#fff;border-radius:12px;padding:1.5rem;max-width:700px;width:90%;max-height:85vh;overflow-y:auto;box-shadow:0 25px 50px rgba(0,0,0,0.2)">
        <h3 style="margin-bottom:1rem;">{{ viewTruck.UnitNumber }} — {{ [viewTruck.Make, viewTruck.Model].filter(Boolean).join(' ') }}</h3>
        <div class="view-grid">
          <div class="view-row"><span class="view-label">Year</span><span>{{ viewTruck.Year || '\u2014' }}</span></div>
          <div class="view-row"><span class="view-label">VIN</span><span>{{ viewTruck.VIN || '\u2014' }}</span></div>
          <div class="view-row"><span class="view-label">License Plate</span><span>{{ viewTruck.LicensePlate || '\u2014' }}</span></div>
          <div class="view-row"><span class="view-label">Status</span><span :class="['status-badge', statusClass(viewTruck.Status)]">{{ viewTruck.Status }}</span></div>
          <div class="view-row"><span class="view-label">Current Driver</span><span>{{ viewTruck.AssignedDriver || '\u2014' }}</span></div>
          <div class="view-row"><span class="view-label">Completed Loads</span><span>{{ viewTruck.LoadCount ?? 0 }}</span></div>
          <div v-if="showOwner" class="view-row"><span class="view-label">Owner</span><span>{{ ownerName(viewTruck.OwnerId) }}</span></div>
          <div class="view-row"><span class="view-label">Purchase Price</span><span>{{ viewTruck.PurchasePrice ? '$' + Number(viewTruck.PurchasePrice).toLocaleString() : '\u2014' }}</span></div>
          <div class="view-row"><span class="view-label">Title Status</span><span>{{ viewTruck.TitleStatus || '\u2014' }}</span></div>
          <div class="view-row"><span class="view-label">Maintenance Fund</span><span>{{ viewTruck.MaintenanceFundMonthly ? '$' + viewTruck.MaintenanceFundMonthly + '/mo' : '\u2014' }}</span></div>
          <div class="view-row">
            <span class="view-label">In Service Since</span>
            <span v-if="inServiceDate(viewTruck)">{{ formatInServiceDate(inServiceDate(viewTruck)) }}</span>
            <span v-else class="view-unset" title="No in-service date set \u2014 fixed costs are billed from the date this truck record was created.">Not set</span>
          </div>
          <div class="view-row">
            <span class="view-label">Retired On</span>
            <span v-if="retiredAt(viewTruck)">{{ formatInServiceDate(retiredAt(viewTruck)) }}</span>
            <span v-else class="view-unset" title="Still in service \u2014 fixed costs keep accruing every month.">In service</span>
          </div>
          <div class="view-row"><span class="view-label">Insurance</span><span>{{ viewTruck.InsuranceMonthly ? '$' + viewTruck.InsuranceMonthly + '/mo' : '\u2014' }}</span></div>
          <div class="view-row"><span class="view-label">ELD</span><span>{{ viewTruck.EldMonthly ? '$' + viewTruck.EldMonthly + '/mo' : '\u2014' }}</span></div>
          <div class="view-row"><span class="view-label">Truck Payment</span><span>{{ viewTruck.TruckPaymentMonthly ? '$' + Number(viewTruck.TruckPaymentMonthly).toLocaleString() + '/mo' : '\u2014' }}</span></div>
          <div class="view-row"><span class="view-label">Driver Pay</span><span>{{ viewTruck.DriverPayDaily ? '$' + viewTruck.DriverPayDaily + '/day' : '$250/day (default)' }}</span></div>
          <!-- Current mileage, derived from the latest ELD fix. Never 0: half
               the fleet has no ELD link at all, and a confident "0 mi" on a
               working tractor is worse than admitting we don't know. -->
          <div class="view-row">
            <span class="view-label">Odometer</span>
            <span v-if="odometerText(viewTruck) !== '—'" class="odo-reading" title="Latest reading from this truck's ELD.">
              {{ odometerText(viewTruck) }}
              <!-- A mileage with no date is unfalsifiable — the reading could be
                   from an hour ago or from the last time the truck ran. -->
              <span v-if="odometerAt(viewTruck)" class="odo-as-of">as of {{ odometerAt(viewTruck) }}</span>
            </span>
            <span v-else class="view-unset" :title="odometerHint(viewTruck)">&mdash; <span class="odo-why">{{ odometerWhy(viewTruck) }}</span></span>
          </div>
          <div class="view-row"><span class="view-label">Fuel Tank</span><span>{{ viewTruck.FuelTankGallons ? viewTruck.FuelTankGallons + ' gal' : '200 gal (default)' }}</span></div>
          <div class="view-row"><span class="view-label">Avg MPG</span><span>{{ viewTruck.AvgMpg ? viewTruck.AvgMpg + ' mpg' : 'Auto from ELD' }}</span></div>
        </div>
        <!-- Driver-personal files (CDL, medical, signed contracts) intentionally
             NOT shown here. They live with the driver, not the truck. Manage
             them from the Drivers Database page. CEO requirement 2026-05-09:
             keep the truck view focused on truck-scoped documents only. -->
        <div style="margin-top:1.25rem;border-top:1px solid #e5e7eb;padding-top:1rem;">
          <LegalDocumentPortal :truck-id="viewTruck.id" :unit-number="viewTruck.UnitNumber" />
        </div>
        <div style="margin-top:1rem;text-align:right;">
          <button class="btn btn-secondary" @click="viewTruck = null">Close</button>
        </div>
      </div>
    </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, reactive, computed, nextTick, shallowRef } from 'vue'
import EmptyState from '../shared/EmptyState.vue'
import ConfirmModal from '../shared/ConfirmModal.vue'
import FileDropZone from '../shared/FileDropZone.vue'
import LegalDocumentPortal from '../investor/LegalDocumentPortal.vue'
import { useApi } from '../../composables/useApi'
import { compressImage, DEFAULT_MAX_EDGE, isDecodedImage, dataUrlHasImageBytes } from '../../lib/imageUtils'
import { amountError, AMOUNT_CAPS } from '../../lib/truckAmounts'
import { formFromTruck, changedFields, bodyForFields, changedUnderneath, inServiceDate, retiredAt } from '../../lib/truckEdit'
import { fmtOdometer } from '../../lib/fuelReview'
import { formatAgeMs } from '../../lib/duration'
import { fmtTimestamp, fmtYmd } from '../../utils/datetime'

const api = useApi()

const truckMakes = [
  'Freightliner', 'Kenworth', 'Peterbilt', 'Volvo', 'International',
  'Mack', 'Western Star', 'Hino', 'Isuzu', 'Ford', 'Chevrolet',
  'RAM', 'GMC', 'Tesla', 'Nikola', 'Other',
]

const truckModels = {
  Freightliner: ['Cascadia', 'Columbia', 'Coronado', 'M2 106', 'M2 112', '114SD', '122SD'],
  Kenworth: ['T680', 'T880', 'W900', 'W990', 'T270', 'T370', 'T440', 'T470'],
  Peterbilt: ['579', '389', '567', '520', '337', '348', '365', '367'],
  Volvo: ['VNL 760', 'VNL 860', 'VNL 300', 'VNR 300', 'VNR 400', 'VNR 600', 'VHD 300', 'VHD 400'],
  International: ['LT', 'RH', 'HV', 'HX', 'MV', 'CV'],
  Mack: ['Anthem', 'Pinnacle', 'Granite', 'LR', 'MD', 'TerraPro'],
  'Western Star': ['4900', '5700XE', '4700', '49X', '47X'],
  Hino: ['L6', 'L7', 'XL7', 'XL8', '268', '338'],
  Isuzu: ['NRR', 'NQR', 'NPR', 'NPR-HD', 'FTR', 'FVR'],
  Ford: ['F-650', 'F-750', 'F-59'],
  Chevrolet: ['Silverado 4500HD', 'Silverado 5500HD', 'Silverado 6500HD'],
  RAM: ['3500', '4500', '5500'],
  GMC: ['Sierra 3500HD', 'Sierra 4500HD', 'Sierra 5500HD'],
  Tesla: ['Semi'],
  Nikola: ['Tre BEV', 'Tre FCEV', 'Two'],
}

const props = defineProps({
  // The rows on this page.
  trucks: { type: Array, default: () => [] },
  // The whole fleet as last loaded, every page. An open Edit dialog finds its
  // truck here: gone from it means deleted, where gone from `trucks` could only
  // mean it now sorts onto another page.
  allTrucks: { type: Array, required: true },
  driverNames: { type: Array, default: () => [] },
  investorUsers: { type: Array, default: () => [] },
  showOwner: { type: Boolean, default: false },
  canEdit: { type: Boolean, default: false },
  // Driver pay is Super Admin only; everyone else sees the rate read-only.
  canEditPay: { type: Boolean, default: false },
  // The Edit dialog's save, awaited in the manner of ExpenseForm's
  // `submit-handler`. saveHandler(id, data) resolves once the truck is saved and
  // rejects with the server's refusal (an Error carrying its message). The
  // dialog closes only on a resolve, so a refused save keeps everything typed.
  saveHandler: { type: Function, required: true },
})

const emit = defineEmits(['delete', 'linkage-changed'])

const showConfirm = ref(false)
const pendingTruck = ref(null)
const viewTruck = ref(null)

const editModelOptions = computed(() => truckModels[editForm.make] || [])

const showEdit = ref(false)
// What the Edit dialog's inputs hold (lib/truckEdit.js, formFromTruck).
const editForm = reactive(formFromTruck(null))
// The same values as the dialog opened with, never edited. Save sends only the
// fields that differ from it (changedFields), so a value someone else saved
// while the dialog was open is not put back.
const editBaseline = shallowRef(null)

// Year + make + model in one cell — "2022 Freightliner Cascadia" is how a fleet
// writes a truck anyway, and it keeps the column COUNT at 12 with Tank added.
// (It does not save width; see the header comment.) Same [year, make, model]
// order the Routemate pick list and the detail-modal heading already use.
function vehicleLabel(truck) {
  return [truck.Year, truck.Make, truck.Model].filter(Boolean).join(' ') || '—'
}

// A VIN's last 6 are the "sequential number" fleets actually quote day to day;
// the full 17 stay one hover (title) or one click (detail modal) away.
function shortVin(vin) {
  const v = String(vin || '').trim()
  return v ? v.slice(-6) : '—'
}

// Serialized PascalCase by GET /api/trucks. 0/blank means the capacity was
// never recorded, which is what silently sends the fuel-range estimate to the
// 200-gal fleet default — returns 0 so the row can say so out loud.
function tankGallons(truck) {
  const n = Number(truck?.FuelTankGallons)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// inServiceDate(truck) and retiredAt(truck), read by the detail modal below, are
// in lib/truckEdit.js with the Edit dialog's form, which reads them too.

// Current mileage, derived server-side from the latest ELD fix. Same defensive
// multi-spelling read as inServiceDate (lib/truckEdit.js), and the same
// tolerance for the field simply not being there — an older server sends no
// Odometer at all, and that has to look identical to "this truck has no ELD
// link" rather than throwing or printing `undefined`.
//
// fmtOdometer collapses null / undefined / '' / 0 to '—' in ONE place shared
// with the fuel panel, so the truck record and the fuel logs can't disagree on
// what a missing reading looks like.
function odometerText(truck) {
  return fmtOdometer(truck?.Odometer ?? truck?.odometer, { unit: ' mi' })
}

// When the reading was taken. An ISO-Z instant from the ELD, so fmtTimestamp
// renders it in Houston WITH a zone label — the house rule for any value that
// carries its own zone. Blank (and the row omits the line) on an older server.
function odometerAt(truck) {
  const at = truck?.OdometerAt ?? truck?.odometer_at ?? ''
  return at ? fmtTimestamp(at, { fallback: '' }) : ''
}

// Why there's no number. The two reasons are genuinely different work items —
// one needs a device linked, the other just needs a ping — so they don't share
// a message. 3 of 6 trucks are currently the first case.
function odometerWhy(truck) {
  return truck?.RoutemateVehicleId ? 'no reading yet' : 'no ELD link'
}
function odometerHint(truck) {
  return truck?.RoutemateVehicleId
    ? 'This truck is linked to an ELD device but no odometer reading has come through yet.'
    : 'No ELD device is linked to this truck, so there is no odometer feed. Link one from the Routemate column in the fleet table.'
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Formats 'YYYY-MM-DD' by string math only — never via `new Date(iso)`, which
// parses as UTC midnight and renders as the previous day in US timezones.
function formatInServiceDate(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw).trim())
  if (!m) return String(raw)
  const month = MONTH_NAMES[Number(m[2]) - 1]
  return month ? `${month} ${Number(m[3])}, ${m[1]}` : String(raw)
}

function openEdit(truck) {
  const values = formFromTruck(truck)
  Object.assign(editForm, values)
  editBaseline.value = Object.freeze(values)
  // A photo still being read for the last truck edited is dropped when it
  // finishes (onEditPhoto), rather than landing in this truck's form.
  photoRead++
  // The modal is v-if'd, so a photo or save message from the last truck edited
  // would otherwise reappear against a different truck. Same for a busy flag
  // left set by a compress that was still running when the modal was dismissed.
  editPhotoError.value = ''
  editPhotoBusy.value = false
  editError.value = ''
  showEdit.value = true
}

// The dialog's truck as the list now has it, or undefined once the list no
// longer holds it: deleted by someone else while the dialog was open.
const editedRow = computed(() => (showEdit.value ? props.allTrucks.find((t) => t.id === editForm.id) : undefined))
const editTruckDeleted = computed(() => showEdit.value && !editedRow.value)
// True when the refreshed row has changed since the dialog opened, on a field
// where the dialog does not already hold the new value (changedUnderneath).
// Save still sends only this dialog's own changes, so a note is all it needs.
const editChangedUnderneath = computed(() => {
  if (!editedRow.value || !editBaseline.value) return false
  return changedUnderneath(editBaseline.value, formFromTruck(editedRow.value), editForm).length > 0
})

const editPhotoBusy = ref(false)
const editPhotoError = ref('')
// Why Save was refused (a number box it can't read, an amount out of range, or
// the server's own refusal); shown directly above Save.
const editError = ref('')
// A save is in flight: Save reads "Saving…" and the dialog stays open.
const editSaving = ref(false)
// Save itself, to hand keyboard focus back after a refusal (handleSaveEdit).
const editSaveBtn = ref(null)
// The edit dialog's element, for unreadableNumberError (null while closed).
const editDialogEl = ref(null)

// Numbers each photo read. openEdit and every close bump it too, so a read that
// finishes after the dialog was closed, or reopened on another truck, sees a
// newer number and is dropped: a slow read (an iPhone HEIC) started on one truck
// used to land in the next truck's form.
let photoRead = 0

// Receives File[] from FileDropZone — a drop and a click both land here.
// compressImage replaces a raw FileReader for the same reason as AddTruckForm:
// the old path POSTed a full-size 12 MP photo as base64 for an 80px thumbnail,
// and could not decode an iPhone HEIC at all.
async function onEditPhoto(files) {
  const file = files[0]
  if (!file) return
  const read = ++photoRead
  editPhotoError.value = ''
  editPhotoBusy.value = true
  try {
    const dataUrl = await compressImage(file, DEFAULT_MAX_EDGE)
    if (read !== photoRead) return
    // Only a real decode is kept. When compressImage cannot decode a file it
    // hands back the RAW bytes under the file's own media type (an SVG, a PDF,
    // …) or '' — and the server refuses any photo that is not a JPEG, PNG or
    // WebP (415 UNSUPPORTED_IMAGE_TYPE). The label alone is not proof: a PDF
    // renamed scan.jpg comes back labelled image/jpeg, so its bytes are checked
    // too. Either way the truck keeps its existing photo rather than losing it,
    // or the whole save, on the next Save.
    if (isDecodedImage(dataUrl) && dataUrlHasImageBytes(dataUrl)) editForm.photo = dataUrl
    else editPhotoError.value = "Couldn't read that photo — use a JPEG, PNG or WebP image."
  } finally {
    // A dropped read leaves the busy flag to the dialog now open.
    if (read === photoRead) editPhotoBusy.value = false
  }
}

// Driver pay sits at the top of this dialog, so it is named first when more
// than one amount is refused; the rest follow in AMOUNT_FIELDS order
// (lib/truckAmounts.js), which is also this dialog's.
const EDIT_AMOUNT_ORDER = ['driverPayDaily']

// The value rule — each amount's range, blank allowed, the refusal naming the
// field — is amountError in lib/truckAmounts.js. The two helpers below are the
// half that needs this dialog's elements; AddTruckForm.vue has the same pair,
// so change them together.

// A number box the browser cannot parse keeps its text on screen but reports
// value '' — in Chrome "1e999", "15-00" and "5e" all do — and v-model reads
// that '' as a deliberate blank. On this form that is not harmless: the PUT
// sends the '' and the server stores 0, so a typo in Insurance would quietly
// zero the truck's stored insurance. Only input.validity.badInput tells
// "cleared" from "unreadable", which is why this reads the DOM. Names the first
// such box by its label; a disabled box (driver pay for a non-Super Admin) is
// never sent, so it is skipped.
//
// ⚠️ Depends on keepUnreadableNumber below: without it the evidence is gone
// before this runs.
function unreadableNumberError(root) {
  if (!root) return ''
  for (const el of root.querySelectorAll('input[type="number"]')) {
    if (el.disabled || !el.validity?.badInput) continue
    const label = el.closest('.form-group, .edit-field')?.querySelector('label')?.textContent.trim()
    return `${label || 'A number field'} can't be read as a number — correct it or clear the box.`
  }
  return ''
}

// v-model on a number box (with or without .number) adds its own 'change'
// listener that rewrites the box with the cast model value — '' for an
// unreadable entry — so without this the typo, and badInput with it, would
// vanish the moment the box loses focus: exactly when Save is pressed, before
// its click handler runs. Stopping that one event here, in the capture phase on
// the dialog, keeps the typo on screen for unreadableNumberError to find and
// for the person to fix. Readable entries pass through untouched.
function keepUnreadableNumber(e) {
  const el = e.target
  if (el?.tagName === 'INPUT' && el.type === 'number' && el.validity?.badInput) e.stopPropagation()
}

// Hides the Edit dialog, and drops a photo read still running for it.
function endEdit() {
  photoRead++
  showEdit.value = false
}

// Closes the Edit dialog, unless a save is still in flight (see the note above
// its buttons).
function closeEdit() {
  if (editSaving.value) return
  endEdit()
}

async function handleSaveEdit() {
  if (editSaving.value || editPhotoBusy.value || editTruckDeleted.value) return
  // Only the fields changed since the dialog opened are sent (lib/truckEdit.js):
  // the rest may have been changed by someone else since, and resending them
  // would put the old values back. Driver pay only for a Super Admin — anyone
  // else's save never carries it. A cleared date is sent as '' (never null,
  // never today), which the server reads as its created_at fallback.
  const changed = changedFields(editBaseline.value, editForm, { canEditPay: props.canEditPay })
  // Checked before anything is sent. The server cannot catch an unreadable
  // number box at all: it arrives as a blank and is stored as 0. Only amounts
  // being sent are range-checked, as the server checks them: a stored value
  // from before a range existed does not block an edit that leaves it alone.
  const sending = Object.fromEntries(changed.map((key) => [key, editForm[key]]))
  editError.value = unreadableNumberError(editDialogEl.value)
    || amountError(sending, { canEditPay: props.canEditPay, order: EDIT_AMOUNT_ORDER })
    || ''
  if (editError.value) return
  // Nothing to save. The server would answer an empty body 400 "No valid
  // fields to update".
  if (!changed.length) {
    endEdit()
    return
  }
  editSaving.value = true
  let refused = false
  try {
    await props.saveHandler(editForm.id, bodyForFields(editForm, changed))
    // Only now. Closing before the server answered turned every refusal (a
    // closed month, a unit number already in use, a photo it would not take)
    // into a toast over a dialog whose edits were all gone.
    endEdit()
  } catch (err) {
    editError.value = err?.message || 'Failed to update truck.'
    refused = true
  } finally {
    editSaving.value = false
  }
  // Disabling Save while it ran dropped keyboard focus to the page body, which
  // sits outside this still-open dialog. Hand it back to Save, unless the
  // person has already moved it somewhere themselves.
  if (refused) {
    await nextTick()
    if (!document.activeElement || document.activeElement === document.body) editSaveBtn.value?.focus()
  }
}

function ownerName(ownerId) {
  if (!ownerId) return '\u2014'
  const inv = props.investorUsers.find(i => i.id === ownerId)
  return inv ? (inv.CompanyName || inv.username) : `#${ownerId}`
}

function statusClass(status) {
  if (status === 'Active') return 'status-active'
  if (status === 'Inactive') return 'status-inactive'
  if (status === 'OOS') return 'status-oos'
  return 'status-maintenance'
}

// Flags a truck in the fleet (any status but Inactive: the server counts a
// truck in Maintenance or OOS in the fixed costs too) that has no fixed-cost
// fields configured — insurance, ELD, truck payment, HVUT, and IRP all
// falsy/0. Such a truck contributes $0 fixed costs to the investor P&L, which
// is almost always a data-entry gap.
// Field names are PascalCase to match the serialized truck objects.
function needsFixedCostSetup(truck) {
  return truck.Status !== 'Inactive' &&
    !truck.InsuranceMonthly &&
    !truck.EldMonthly &&
    !truck.TruckPaymentMonthly &&
    !truck.HvutAnnual &&
    !truck.IrpAnnual
}

// The badge's tooltip. Everyone on this page reads what the badge means, an
// investor included (their My Trucks); only a user who can edit trucks is told
// where to add the costs, since the page offers an investor no Edit.
const FIXED_COST_SETUP_MEANING = 'No insurance, ELD, truck payment, HVUT, or IRP is configured for this truck — its fixed costs show as $0 in the investor P&L.'
const fixedCostSetupHint = computed(() => (props.canEdit
  ? `${FIXED_COST_SETUP_MEANING} Add them via Edit → Business Configuration.`
  : FIXED_COST_SETUP_MEANING))

function confirmDelete(truck) {
  pendingTruck.value = truck
  showConfirm.value = true
}

function handleConfirmDelete() {
  if (pendingTruck.value) emit('delete', pendingTruck.value.id)
  showConfirm.value = false
  pendingTruck.value = null
}

// --- Routemate device linkage ---
const showLinkRm = ref(false)
const linkTruck = ref(null)
const unlinkedVehicles = ref([])
const pickedRoutemateId = ref('')
const linkBusy = ref(false)
const linkLoading = ref(false)
// Two error slots, deliberately separate. `linkError` means "the vehicle list
// itself is unavailable", so the picker genuinely has nothing to show.
// `autoError` means "auto-match failed" — the list is still perfectly good and
// must stay on screen. They were one ref, and because the picker renders in a
// v-else-if chain after the error, a failed auto-match REPLACED the whole list
// with the error text and left the admin with no way to link manually until
// they closed and reopened the modal.
const linkError = ref('')
const autoError = ref('')
const suggestedId = ref('')
// A 409 ELD_DEVICE_SILENT, kept with the request body that drew it so "Link
// anyway" resends exactly that request with confirmSilent. Any other pick
// clears it, since it would then be about a device no longer chosen.
const silentPrompt = ref(null)
const silentPromptEl = ref(null)

// The modal opened from a linked truck's Change button: same list and the same
// POST, which re-points the link, so a wrong link is fixed without unlinking.
const repointing = computed(() => !!linkTruck.value?.RoutemateVehicleId)

const PROVIDER_LABELS = { routemate: 'Routemate', linxup: 'Linxup' }

function providerKey(p) {
  return String(p || '').trim().toLowerCase()
}

// '' when the server names no provider, so no badge renders at all.
function providerLabel(p) {
  const key = providerKey(p)
  if (!key) return ''
  return PROVIDER_LABELS[key] || key.charAt(0).toUpperCase() + key.slice(1)
}

function providerClass(p) {
  const key = providerKey(p)
  return PROVIDER_LABELS[key] ? `rm-provider-${key}` : ''
}

// The linked device's vehicle number as the provider knows it ("356"), the same
// name the pick list leads with; '' when it has none, and callers fall back to
// the device id.
function eldVehicleNumber(truck) {
  return String(truck?.EldVehicleNumber || '').trim()
}

// The device's last GPS fix (epoch ms) as an ISO-Z instant, so the datetime
// helpers render it in Houston time; '' when there is none.
function fixIso(ms) {
  if (ms == null || ms === '') return ''
  const d = new Date(Number(ms))
  return isNaN(d.getTime()) ? '' : d.toISOString()
}

function fixAge(ms) {
  return formatAgeMs(Date.now() - Number(ms))
}

// One line under each device: how recently it reported. Whether that counts as
// silent is the server's call (`silent` / EldSilent), never re-derived here.
// '' only when the server sent neither a fix nor a silent flag.
function fixLine(ms, silent) {
  if (!fixIso(ms)) return silent ? 'Never reported' : ''
  return silent
    ? `No GPS fix since ${fmtYmd(fixIso(ms))} (${fixAge(ms)})`
    : `Last fix ${fixAge(ms)} ago`
}

function silentChipText(ms) {
  return fixIso(ms) ? `Silent ${fixAge(ms)}` : 'Never reported'
}

function silentTitle(ms) {
  const iso = fixIso(ms)
  const what = iso ? `No GPS fix since ${fmtTimestamp(iso)}` : 'This device has never sent a GPS fix'
  return `${what} — the device may be unplugged, or linked to the wrong truck.`
}

// The "Linked" chip's hover text: which device, from which provider, and when
// it last reported. The clock time rides along because the age is worked out
// when the row renders, and a page left open for hours would otherwise go on
// showing an age that has stopped counting.
function linkedTitle(truck) {
  const label = providerLabel(truck.EldProvider) || 'ELD'
  const number = eldVehicleNumber(truck)
  const device = number ? `${label} vehicle ${number}` : `${label} device ${truck.RoutemateVehicleId}`
  const iso = fixIso(truck.EldLastFixMs)
  if (iso) return `${device} — last GPS fix ${fixAge(truck.EldLastFixMs)} ago (${fmtTimestamp(iso)})`
  return truck.EldSilent ? `${device} — has never sent a GPS fix` : device
}

function pickDevice(id) {
  if (silentPrompt.value && silentPrompt.value.body.routemateVehicleId !== id) silentPrompt.value = null
  pickedRoutemateId.value = id
}

// True when the mirror carries no VIN for any offered device — in that state
// "Auto-match by VIN" cannot succeed for any truck, so say so up front rather
// than letting the admin discover it by clicking.
const noVinData = computed(() =>
  unlinkedVehicles.value.length > 0 && !unlinkedVehicles.value.some(v => (v.vin || '').trim())
)

async function openLinkModal(truck) {
  // The dialog reports its own refusals; a stale unlink message would only
  // outlive whatever this dialog changes.
  unlinkError.value = null
  linkTruck.value = truck
  pickedRoutemateId.value = ''
  suggestedId.value = ''
  linkError.value = ''
  autoError.value = ''
  silentPrompt.value = null
  showLinkRm.value = true
  linkLoading.value = true
  try {
    // ?truckId lets the server suggest the likely device by unit number
    // (Routemate's vehicleId "91" ↔ our "Logisx-#91"). The rule lives server-side
    // so it cannot drift from the auto-match branch that uses the same helper.
    const r = await api.get(`/api/routemate/vehicles/unlinked?truckId=${encodeURIComponent(truck.id)}`)
    unlinkedVehicles.value = r.vehicles || []
    if (r.suggested?.routemate_vehicle_id) {
      suggestedId.value = r.suggested.routemate_vehicle_id
      // Pre-select, never auto-submit: the admin still confirms with
      // "Link Selected". The ELD link is a driver-pay input, so a unit-number
      // guess is not strong enough to bind on its own.
      pickedRoutemateId.value = r.suggested.routemate_vehicle_id
    }
  } catch (err) {
    linkError.value = err?.message || 'Failed to load Routemate vehicles.'
  } finally {
    linkLoading.value = false
  }
}

function closeLinkModal() {
  if (linkBusy.value) return
  showLinkRm.value = false
  linkTruck.value = null
  unlinkedVehicles.value = []
  pickedRoutemateId.value = ''
  suggestedId.value = ''
  linkError.value = ''
  autoError.value = ''
  silentPrompt.value = null
}

// One POST for every way of linking: Link Selected ({ routemateVehicleId }),
// Auto-match ({ auto: true }) and Link anyway (either, plus confirmSilent).
// On a linked truck the same POST re-points the link.
async function submitLink(body) {
  if (!linkTruck.value) return
  const auto = body.auto === true
  linkBusy.value = true
  // Auto-match clears autoError only — clearing linkError too would wrongly
  // imply the vehicle list had recovered.
  if (!auto) linkError.value = ''
  autoError.value = ''
  // Link anyway keeps its prompt on screen, reading "Linking...", until the
  // answer arrives.
  if (!body.confirmSilent) silentPrompt.value = null
  try {
    await api.post(`/api/trucks/${linkTruck.value.id}/link-routemate`, body)
    showLinkRm.value = false
    // Reload-only signal: the parent should refetch trucks so the row's
    // RoutemateVehicleId flips to "Linked". Distinct from `saveHandler` (the
    // PUT to /api/trucks behind the Edit dialog's field edits).
    emit('linkage-changed', { id: linkTruck.value.id })
  } catch (err) {
    silentPrompt.value = null
    if (err?.code === 'ELD_DEVICE_SILENT' && !body.confirmSilent) {
      silentPrompt.value = { body, error: err.message }
      await nextTick()
      silentPromptEl.value?.focus()
    } else if (auto) {
      autoError.value = err?.message || 'No Routemate vehicle matches this VIN.'
      // The server offers a fallback candidate matched on unit number. Surface it
      // as a pre-selection so a failed auto-match is a one-click recovery rather
      // than a dead end.
      const suggested = err?.data?.suggestion?.routemate_vehicle_id
      if (suggested) {
        suggestedId.value = suggested
        pickedRoutemateId.value = suggested
      }
    } else {
      linkError.value = err?.message || 'Failed to link Routemate vehicle.'
    }
  } finally {
    linkBusy.value = false
  }
}

function handleLink() {
  if (!pickedRoutemateId.value) return
  return submitLink({ routemateVehicleId: pickedRoutemateId.value })
}

function handleAutoLink() {
  if (!linkTruck.value?.VIN) return
  return submitLink({ auto: true })
}

function handleLinkAnyway() {
  if (!silentPrompt.value) return
  return submitLink({ ...silentPrompt.value.body, confirmSilent: true })
}

// A refused unlink, shown in a row under its truck: { truckId, message }.
const unlinkError = ref(null)

// Every column the header renders, so the error row spans the whole table.
const columnCount = computed(() => 10 + (props.showOwner ? 1 : 0) + (props.canEdit ? 1 : 0))

async function handleUnlink(truck) {
  // No confirm modal — unlink is reversible (admin can re-link any time).
  unlinkError.value = null
  try {
    await api.del(`/api/trucks/${truck.id}/link-routemate`)
    emit('linkage-changed', { id: truck.id })
  } catch (err) {
    unlinkError.value = {
      truckId: truck.id,
      message: err?.message || `Could not unlink the ELD device from ${truck.UnitNumber || 'this truck'}.`,
    }
  }
}
</script>

<style scoped>
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.25rem;
  margin-bottom: 1.25rem;
}
.admin-section-title {
  display: flex; align-items: center; gap: 0.5rem;
  font-weight: 700; font-size: 0.88rem; margin-bottom: 1rem;
}
.section-dot { width: 8px; height: 8px; border-radius: 50%; }

.truck-table {
  width: 100%; border-collapse: separate; border-spacing: 0;
  font-size: 0.82rem; margin-top: 0.5rem;
}
.truck-table th {
  text-align: left; padding: 0.6rem 0.5rem; font-weight: 600;
  color: var(--text-dim); border-bottom: 2px solid var(--border);
  font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em;
}
.truck-table td {
  padding: 0.65rem 0.5rem; border-bottom: 1px solid var(--bg); vertical-align: middle;
}
.truck-table tbody tr { transition: background 0.1s; }
.truck-table tbody tr:hover { background: var(--bg); }
.truck-table tbody tr:last-child td { border-bottom: none; }

.unit-number {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
}
.vin-cell {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  color: var(--text-dim);
}

.status-badge {
  display: inline-flex; align-items: center;
  padding: 0.2rem 0.6rem; border-radius: 12px;
  font-size: 0.68rem; font-weight: 600;
  font-family: 'JetBrains Mono', monospace; letter-spacing: 0.02em;
}
.status-active { background: var(--accent-dim); color: var(--accent); }
.status-inactive { background: var(--bg); color: var(--text-dim); }
.status-maintenance { background: var(--amber-dim); color: var(--amber); }
.status-oos { background: var(--danger-dim); color: var(--danger); }

.action-btns { display: flex; gap: 0.35rem; justify-content: flex-end; }

.btn-edit, .btn-remove {
  padding: 0.3rem 0.65rem; font-size: 0.7rem; border-radius: 6px;
  border: 1px solid var(--border); background: var(--surface);
  cursor: pointer; font-family: inherit; font-weight: 500;
  color: var(--text-dim); transition: all 0.15s;
}
.btn-edit:hover { background: var(--blue-dim); color: var(--blue); border-color: var(--blue-dim); }
.btn-remove:hover { background: var(--danger-dim); color: var(--danger); border-color: var(--danger-dim); }

/* Edit modal */
.confirm-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.3);
  display: flex; align-items: center; justify-content: center;
  z-index: 200;
}
.confirm-dialog {
  background: var(--surface); border-radius: var(--radius);
  padding: 1.5rem; max-width: 500px; width: 90%;
  box-shadow: 0 8px 30px rgba(0,0,0,0.12);
  max-height: 90vh; overflow-y: auto;
}
.confirm-dialog h3 { font-size: 1rem; margin-bottom: 1rem; }
.confirm-actions {
  display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1.25rem;
}
/* Save refusal — the same red callout as the Routemate modal's errors below. */
.edit-error {
  padding: 0.55rem 0.7rem; font-size: 0.75rem; line-height: 1.4;
  background: #fef2f2; color: #991b1b;
  border: 1px solid #fecaca; border-radius: 6px;
}
.edit-error + .confirm-actions { margin-top: 0.75rem; }
/* Someone else saved this truck meanwhile — a notice, not a refusal. */
.edit-note {
  padding: 0.55rem 0.7rem; font-size: 0.75rem; line-height: 1.4;
  background: #fffbeb; color: #92400e;
  border: 1px solid #fde68a; border-radius: 6px;
}
.edit-note + .edit-error { margin-top: 0.5rem; }
.edit-note + .confirm-actions { margin-top: 0.75rem; }
/* Groups the fields only so a save in flight can disable them all at once. */
.edit-fields { border: 0; margin: 0; padding: 0; min-width: 0; }
/* Matches the global .btn-primary:disabled; Cancel is held while a save or a
   Routemate link is in flight, and should look it. */
.confirm-actions .btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }

.edit-row { display: flex; gap: 1rem; }
.edit-row .edit-field { flex: 1; }

.edit-field { margin-bottom: 0.75rem; }
.edit-field label {
  display: block; font-size: 0.72rem; font-weight: 600;
  color: var(--text-dim); text-transform: uppercase;
  letter-spacing: 0.04em; margin-bottom: 0.3rem;
}
.edit-field select,
.edit-field input,
.edit-field textarea {
  width: 100%; padding: 0.5rem 0.65rem; border: 1px solid var(--border);
  border-radius: 6px; font-family: inherit; font-size: 0.82rem;
  background: var(--bg); color: var(--text); resize: vertical;
}
.edit-field select:focus,
.edit-field input:focus,
.edit-field textarea:focus {
  outline: none; border-color: var(--blue);
}
/* Read-only for this role (driver pay is Super Admin only), or held while a
   save is in flight: still legible. */
.edit-field input:disabled,
.edit-fields:disabled select,
.edit-fields:disabled textarea { opacity: 0.6; cursor: not-allowed; }
.field-hint {
  font-size: 0.7rem; color: var(--text-dim); margin-top: 0.25rem;
  text-transform: none; letter-spacing: normal;
}
.pay-default { color: var(--text-dim); font-size: 0.72rem; }
/* Same dimmed "this is a fallback, not a fact" treatment as .pay-default. */
.tank-default { color: var(--text-dim); font-size: 0.72rem; cursor: help; }
.cost-warning-badge {
  display: inline-block;
  padding: 0.15rem 0.5rem; border-radius: 10px;
  font-size: 0.62rem; font-weight: 600; line-height: 1.3;
  background: #fef3c7; color: #92400e; border: 1px solid #fde68a;
  cursor: help; white-space: normal; max-width: 150px;
}
.clickable-row { cursor: pointer; }
.clickable-row:hover td { background: var(--accent-dim, #f0f9ff); }
.view-grid { display: flex; flex-direction: column; gap: 0.4rem; }
.view-row { display: flex; justify-content: space-between; padding: 0.4rem 0; border-bottom: 1px solid #f1f5f9; font-size: 0.85rem; }
.view-label { font-weight: 600; color: var(--text-dim); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; }
.view-unset { color: var(--text-dim); cursor: help; }
.odo-reading { font-family: 'JetBrains Mono', monospace; text-align: right; }
.odo-as-of {
  display: block;
  font-family: 'DM Sans', sans-serif;
  font-size: 0.68rem;
  color: var(--text-dim);
}
/* The em dash is the value; the reason is a footnote to it, not a substitute. */
.odo-why { font-size: 0.72rem; }

/* Routemate column — minimal "Linked / Link / —" affordances. */
.rm-linked {
  display: inline-flex; align-items: center; gap: 0.3rem;
  font-size: 0.7rem; font-weight: 600;
  padding: 0.15rem 0.5rem; border-radius: 10px;
  background: #dcfce7; color: #166534;
  border: 1px solid #bbf7d0;
}
.rm-dot {
  width: 6px; height: 6px; border-radius: 50%; background: #16a34a;
}
.rm-unlinked { color: var(--text-dim); }
.btn-link-rm {
  padding: 0.3rem 0.65rem; font-size: 0.7rem; border-radius: 6px;
  border: 1px solid #bfdbfe; background: #eff6ff;
  cursor: pointer; font-family: inherit; font-weight: 600;
  color: #1e40af; transition: all 0.15s;
}
.btn-link-rm:hover { background: #dbeafe; border-color: #93c5fd; }
.btn-unlink-rm {
  margin-left: 0.35rem;
  width: 18px; height: 18px;
  border: 1px solid var(--border); background: var(--surface);
  color: var(--text-dim); border-radius: 50%;
  cursor: pointer; line-height: 1;
  font-size: 0.85rem; padding: 0;
}
.btn-unlink-rm:hover { background: var(--danger-dim); color: var(--danger); border-color: var(--danger-dim); }
/* Linked, but the device has stopped reporting: the dot stops claiming "live". */
.rm-dot-silent { background: #d97706; }
.rm-cell-extra {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem;
  margin-top: 0.3rem;
}
/* Same amber callout as .cost-warning-badge, and free to wrap like it: this
   column has almost no width to spare (see COLUMN BUDGET above). */
.rm-silent-badge {
  display: inline-block;
  padding: 0.15rem 0.5rem; border-radius: 10px;
  font-size: 0.62rem; font-weight: 600; line-height: 1.3;
  background: #fef3c7; color: #92400e; border: 1px solid #fde68a;
  cursor: help;
}
.btn-change-rm {
  padding: 0.15rem 0.5rem; font-size: 0.66rem; border-radius: 6px;
  border: 1px solid var(--border); background: var(--surface);
  cursor: pointer; font-family: inherit; font-weight: 600;
  color: var(--text-dim); transition: all 0.15s;
}
.btn-change-rm:hover { background: var(--blue-dim); color: var(--blue); border-color: var(--blue-dim); }

/* Pick list inside the link modal */
.rm-pick-list {
  max-height: 320px; overflow-y: auto;
  border: 1px solid var(--border); border-radius: 6px;
  margin-bottom: 0.75rem;
}
.rm-pick-item {
  display: block; position: relative;
  padding: 0.6rem 0.75rem; cursor: pointer;
  border-bottom: 1px solid var(--bg);
  transition: background 0.1s;
}
.rm-pick-item:last-child { border-bottom: none; }
.rm-pick-item:hover { background: var(--bg); }
.rm-pick-item:has(.rm-pick-radio:focus-visible) { outline: 2px solid #3b82f6; outline-offset: -2px; }
/* Visually hidden, still focusable and announced; the whole label is the target. */
.rm-pick-radio {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.rm-pick-item.selected { background: #eff6ff; border-left: 3px solid #3b82f6; padding-left: calc(0.75rem - 3px); }
/* A device that has stopped reporting: its details recede, its warning line
   (.rm-pick-fix.warn) stays at full strength. */
.rm-pick-item.silent .rm-pick-line1,
.rm-pick-item.silent .rm-pick-line2 { opacity: 0.55; }
.rm-pick-line1 {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.2rem 0.6rem; margin-bottom: 0.15rem;
}
.rm-pick-id { font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 0.78rem; overflow-wrap: anywhere; }
.rm-pick-vin { font-family: 'JetBrains Mono', monospace; font-size: 0.68rem; color: var(--text-dim); overflow-wrap: anywhere; }
.rm-pick-line2 { font-size: 0.72rem; color: var(--text-dim); display: flex; flex-wrap: wrap; gap: 0.2rem 0.6rem; }
.rm-pick-eld { font-family: 'JetBrains Mono', monospace; }
.rm-provider {
  display: inline-block;
  padding: 0.05rem 0.45rem; border-radius: 10px;
  font-size: 0.62rem; font-weight: 600; line-height: 1.4;
  background: var(--bg); color: var(--text-dim); border: 1px solid var(--border);
}
.rm-provider-routemate { background: #eff6ff; color: #1e40af; border-color: #bfdbfe; }
.rm-provider-linxup { background: #f5f3ff; color: #5b21b6; border-color: #ddd6fe; }
.rm-pick-fix { display: block; margin-top: 0.2rem; font-size: 0.7rem; color: var(--text-dim); }
.rm-pick-fix.warn { color: #92400e; font-weight: 600; }
/* Re-point mode: the device the truck is linked to now, above the list. */
.rm-current {
  padding: 0.55rem 0.75rem; margin-bottom: 0.75rem;
  border: 1px solid var(--border); border-radius: 6px; background: var(--bg);
}
.rm-current-label {
  font-size: 0.66rem; font-weight: 600; color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.2rem;
}
.rm-current-note { margin-top: 0.3rem; font-size: 0.7rem; color: var(--text-dim); }
/* 409 ELD_DEVICE_SILENT: the server's words plus the one way past it. Same
   amber as .rm-auto-note — a decision to make, not a failure. */
.rm-silent-prompt {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem;
  padding: 0.55rem 0.7rem; font-size: 0.75rem; line-height: 1.4;
  background: #fffbeb; color: #92400e;
  border: 1px solid #fde68a; border-radius: 6px;
}
.rm-silent-prompt > div { flex: 1 1 14rem; min-width: 0; overflow-wrap: anywhere; }
.rm-silent-prompt:focus { outline: 2px solid #f59e0b; outline-offset: 1px; }
.btn-link-anyway {
  padding: 0.3rem 0.65rem; font-size: 0.72rem; border-radius: 6px;
  border: 1px solid #f59e0b; background: #fef3c7;
  cursor: pointer; font-family: inherit; font-weight: 600; color: #92400e;
}
.btn-link-anyway:hover { background: #fde68a; }
.btn-link-anyway:disabled { opacity: 0.5; cursor: not-allowed; }
.rm-pick-empty { padding: 1rem; font-size: 0.82rem; color: var(--text-dim); text-align: center; }
.rm-pick-error {
  padding: 0.6rem 0.75rem; font-size: 0.78rem;
  background: #fef2f2; color: #991b1b;
  border: 1px solid #fecaca; border-radius: 6px; margin-bottom: 0.75rem;
}
/* A refused unlink, in the row under its truck: the .rm-pick-error callout,
   with room for a dismiss button. */
.truck-table tbody tr.rm-error-row:hover { background: transparent; }
.rm-error-row td { padding-top: 0; }
.rm-unlink-error {
  display: flex; align-items: flex-start; gap: 0.5rem;
  margin-bottom: 0; line-height: 1.4; overflow-wrap: anywhere;
}
.rm-unlink-error > span { flex: 1; min-width: 0; }
.rm-error-dismiss {
  flex: none; width: 20px; height: 20px; padding: 0; line-height: 1;
  border: 1px solid #fecaca; border-radius: 50%; background: #fff;
  color: #991b1b; font-size: 0.85rem; cursor: pointer;
}
.rm-error-dismiss:hover { background: #fee2e2; }
/* Auto-match feedback sits under its own button, not in the picker's slot, so
   the device list stays on screen when auto-match fails. */
.rm-auto-error {
  margin-top: 0.5rem; padding: 0.55rem 0.7rem; font-size: 0.75rem; line-height: 1.4;
  background: #fef2f2; color: #991b1b;
  border: 1px solid #fecaca; border-radius: 6px;
}
.rm-auto-note {
  margin-top: 0.5rem; padding: 0.55rem 0.7rem; font-size: 0.75rem; line-height: 1.4;
  background: #fffbeb; color: #92400e;
  border: 1px solid #fde68a; border-radius: 6px;
}
.rm-pick-item.suggested { background: #f0fdf4; }
.rm-pick-item.suggested.selected { background: #eff6ff; }
.rm-pick-suggest {
  display: block;
  margin-top: 0.3rem; font-size: 0.68rem; font-weight: 600; color: #15803d;
}
</style>
