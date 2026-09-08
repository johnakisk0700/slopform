import {
  Avatar,
  Button,
  Chip,
  Drawer,
  ErrorMessage,
  Input,
  Label,
  ListBox,
  Modal,
  Pagination,
  Popover,
  ScrollShadow,
  Select,
  Slider,
  Switch,
  Table,
  TextArea,
  TextField,
  ToggleButton,
  toast,
} from "@heroui/react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";

import { HEROUI_SECTION } from "./cookbookSections";
import { Section, Specimen } from "./Specimen";
import { PARTICIPANT_SAMPLE, QUEUE_SAMPLE } from "./tableSpecimens";

export function HeroUISection() {
  const [isDrawerOpen, setDrawerOpen] = useState(false);

  const [page, setPage] = useState(2);

  // Controlled, like every field the product ships: HeroUI's TextField feeds
  // its own `value` to the DOM element through react-aria context, so an
  // uncontrolled `defaultValue` child renders with both props and React
  // reports the conflict on every mount.
  const [eventName, setEventName] = useState("Δείπνο στο Κολωνάκι");

  const [venueAddress, setVenueAddress] = useState("");

  const [operatorNote, setOperatorNote] = useState(
    "Η Ελένη ζήτησε τραπέζι κοντά στο παράθυρο.",
  );

  const [venueInFeedback, setVenueInFeedback] = useState(true);
  return (
    <Section spec={HEROUI_SECTION}>
      <div className="grid gap-3 lg:grid-cols-2">
        <Specimen label="Buttons — variants">
          <Button variant="primary">Launch campaign</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="tertiary">Tertiary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Close campaign</Button>
          <Button variant="danger-soft">Danger soft</Button>
          <Button isDisabled>Disabled</Button>
        </Specimen>

        <Specimen
          label="Buttons — sizes & icon-only"
          note="An icon-only control always carries an aria-label; the glyph itself is aria-hidden."
        >
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
          <Button isIconOnly aria-label="Next page" variant="outline">
            <ChevronRight aria-hidden="true" className="size-4" />
          </Button>
          <Button isIconOnly aria-label="Confirm" variant="ghost" isDisabled>
            <Check aria-hidden="true" className="size-4" />
          </Button>
        </Specimen>

        <Specimen label="Chips — colours (soft)">
          <Chip variant="soft">Default</Chip>
          <Chip variant="soft" color="accent">
            Accent
          </Chip>
          <Chip variant="soft" color="success">
            Success
          </Chip>
          <Chip variant="soft" color="warning">
            Warning
          </Chip>
          <Chip variant="soft" color="danger">
            Danger
          </Chip>
        </Specimen>

        <Specimen
          label="Chips — variants & sizes"
          note="HeroUI's chip has no slate `info` slot, which is why the feedback screens carry their own badge instead."
        >
          <Chip variant="primary" color="accent">
            Primary
          </Chip>
          <Chip variant="secondary" color="accent">
            Secondary
          </Chip>
          <Chip variant="tertiary" color="accent">
            Tertiary
          </Chip>
          <Chip variant="soft" color="accent" size="sm">
            Small
          </Chip>
          <Chip variant="soft" color="accent" size="lg">
            Large
          </Chip>
        </Specimen>

        <Specimen label="Text fields" className="grid gap-4">
          <TextField fullWidth>
            <Label className="text-sm font-semibold text-ink">Event name</Label>
            <Input
              value={eventName}
              onChange={(change) => setEventName(change.target.value)}
              autoComplete="off"
              className="w-full"
            />
          </TextField>
          <TextField fullWidth isInvalid>
            <Label className="text-sm font-semibold text-ink">
              Venue address
            </Label>
            <Input
              value={venueAddress}
              onChange={(change) => setVenueAddress(change.target.value)}
              autoComplete="off"
              className="w-full"
            />
            <ErrorMessage className="mt-1.5">
              A venue is required before the dinner can leave draft.
            </ErrorMessage>
          </TextField>
          <TextField fullWidth>
            <Label className="text-sm font-semibold text-ink">
              Operator note
            </Label>
            <TextArea
              rows={3}
              value={operatorNote}
              onChange={(change) => setOperatorNote(change.target.value)}
              className="w-full"
            />
          </TextField>
        </Specimen>

        <Specimen label="Choice controls" className="grid gap-4">
          <div className="grid gap-1.5">
            <span className="jts-overline text-ink-muted">Campaign</span>
            <Select aria-label="Campaign" defaultSelectedKey="kolonaki">
              <Select.Trigger className="w-full">
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  <ListBox.Item id="kolonaki" textValue="Δείπνο στο Κολωνάκι">
                    Δείπνο στο Κολωνάκι
                  </ListBox.Item>
                  <ListBox.Item id="pagkrati" textValue="Πέμπτη στο Παγκράτι">
                    Πέμπτη στο Παγκράτι
                  </ListBox.Item>
                  <ListBox.Item id="kyriaki" textValue="Κυριακάτικο τραπέζι">
                    Κυριακάτικο τραπέζι
                  </ListBox.Item>
                </ListBox>
              </Select.Popover>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <span className="jts-overline text-ink-muted">
              Event score correction
            </span>
            <Slider
              aria-label="Event score"
              minValue={1}
              maxValue={6}
              step={1}
              defaultValue={4}
              className="w-48"
            >
              <Slider.Track>
                <Slider.Fill />
                <Slider.Thumb />
              </Slider.Track>
            </Slider>
          </div>
          <div className="grid gap-1.5">
            <span className="jts-overline text-ink-muted">Toggle button</span>
            <ToggleButton
              className="w-fit rounded-md"
              defaultSelected
              aria-label="Only conversations needing attention"
            >
              Needs attention
            </ToggleButton>
          </div>
          <div className="grid gap-1.5">
            <span className="jts-overline text-ink-muted">Switch</span>
            <Switch isSelected={venueInFeedback} onChange={setVenueInFeedback}>
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                <span className="text-sm font-semibold">
                  Use venue context in Luna
                </span>
              </Switch.Content>
            </Switch>
          </div>
        </Specimen>

        <Specimen
          label="Overlays"
          note="Each one opens for real — a bridge edit to --overlay, --backdrop or --overlay-shadow shows up only when the thing is open."
        >
          <Popover>
            <Button variant="outline">Open popover</Button>
            <Popover.Content placement="bottom">
              <Popover.Dialog
                aria-label="Popover specimen"
                className="grid max-w-[18rem] gap-1"
              >
                <p className="jts-overline text-ink-muted">Popover surface</p>
                <p className="text-sm text-ink-muted">
                  Positioned surface on <code>--jts-color-surface-overlay</code>{" "}
                  with <code>--jts-shadow-md</code>.
                </p>
              </Popover.Dialog>
            </Popover.Content>
          </Popover>

          <Modal>
            <Button variant="outline">Open modal</Button>
            <Modal.Backdrop>
              <Modal.Container size="sm" placement="center">
                <Modal.Dialog>
                  <Modal.Header className="flex items-start justify-between gap-4">
                    <Modal.Heading className="text-[1.05rem] font-bold tracking-tight text-ink">
                      Modal specimen
                    </Modal.Heading>
                    <Modal.CloseTrigger />
                  </Modal.Header>
                  <Modal.Body>
                    <p className="text-sm text-ink-muted">
                      The backdrop, the container radius and the dialog surface
                      all come from the bridge. Nothing here is real — no dinner
                      was created.
                    </p>
                  </Modal.Body>
                  <Modal.Footer className="flex justify-end gap-3">
                    <Button variant="ghost">Cancel</Button>
                    <Button>Confirm</Button>
                  </Modal.Footer>
                </Modal.Dialog>
              </Modal.Container>
            </Modal.Backdrop>
          </Modal>

          <Drawer isOpen={isDrawerOpen} onOpenChange={setDrawerOpen}>
            <Button variant="outline">Open drawer</Button>
            <Drawer.Backdrop>
              <Drawer.Content placement="right">
                <Drawer.Dialog>
                  <Drawer.Header className="flex items-center justify-between gap-3">
                    <Drawer.Heading className="font-display text-[1.15rem] font-extrabold tracking-tight text-ink">
                      Drawer specimen
                    </Drawer.Heading>
                    <Drawer.CloseTrigger />
                  </Drawer.Header>
                  <Drawer.Body>
                    <p className="text-sm text-ink-muted">
                      The same surface the small-screen navigation uses, opened
                      from the right so it does not read as the nav.
                    </p>
                  </Drawer.Body>
                </Drawer.Dialog>
              </Drawer.Content>
            </Drawer.Backdrop>
          </Drawer>

          <Button
            variant="outline"
            onPress={() =>
              toast.success("Specimen toast", {
                description:
                  "Fired from the cookbook. Nothing was sent to anyone.",
              })
            }
          >
            Fire a toast
          </Button>
        </Specimen>

        <Specimen
          label="Avatars"
          note="Rounded square: the circle stays reserved for the brand mark."
        >
          <Avatar
            color="accent"
            variant="soft"
            size="sm"
            className="rounded-md"
          >
            <Avatar.Fallback>ΕΠ</Avatar.Fallback>
          </Avatar>
          <Avatar
            color="accent"
            variant="soft"
            size="md"
            className="rounded-md"
          >
            <Avatar.Fallback>ΝΑ</Avatar.Fallback>
          </Avatar>
          <Avatar
            color="success"
            variant="soft"
            size="lg"
            className="rounded-md"
          >
            <Avatar.Fallback>ΜΒ</Avatar.Fallback>
          </Avatar>
          <Avatar
            color="danger"
            variant="soft"
            size="lg"
            className="rounded-md"
          >
            <Avatar.Fallback>ΘΚ</Avatar.Fallback>
          </Avatar>
        </Specimen>

        <Specimen label="List box" className="grid gap-2">
          <ListBox
            aria-label="Participants"
            selectionMode="single"
            defaultSelectedKeys={["Μαρία Βλάχου"]}
            className="max-h-40"
          >
            {PARTICIPANT_SAMPLE.slice(0, 4).map((name) => (
              <ListBox.Item key={name} id={name} textValue={name}>
                {name}
              </ListBox.Item>
            ))}
          </ListBox>
        </Specimen>

        <Specimen
          label="Scroll shadow"
          note="Keyboard-reachable on purpose: a scrollable region nobody can tab into is a region some operators cannot read."
          className="grid gap-2"
        >
          <ScrollShadow
            role="region"
            aria-label="Participant sample"
            tabIndex={0}
            orientation="vertical"
            className="max-h-28 w-full overflow-y-auto rounded-sm border border-border bg-surface-sunken p-2 focus-visible:-outline-offset-2"
          >
            <ul className="grid gap-1">
              {PARTICIPANT_SAMPLE.map((name) => (
                <li key={name} className="text-sm text-ink">
                  {name}
                </li>
              ))}
            </ul>
          </ScrollShadow>
        </Specimen>

        <Specimen label="Pagination" className="grid gap-2">
          <Pagination aria-label="Specimen pagination">
            <Pagination.Content className="flex items-center gap-1">
              <Pagination.Item>
                <Pagination.Previous
                  aria-label="Previous page"
                  isDisabled={page === 1}
                  onPress={() => setPage((current) => Math.max(1, current - 1))}
                >
                  <ChevronLeft aria-hidden="true" className="size-4" />
                </Pagination.Previous>
              </Pagination.Item>
              {[1, 2, 3].map((item) => (
                <Pagination.Item key={item}>
                  <Pagination.Link
                    isActive={item === page}
                    aria-label={`Page ${item}`}
                    onPress={() => setPage(item)}
                  >
                    {item}
                  </Pagination.Link>
                </Pagination.Item>
              ))}
              <Pagination.Item>
                <Pagination.Ellipsis />
              </Pagination.Item>
              <Pagination.Item>
                <Pagination.Next
                  aria-label="Next page"
                  isDisabled={page === 3}
                  onPress={() => setPage((current) => Math.min(3, current + 1))}
                >
                  <ChevronRight aria-hidden="true" className="size-4" />
                </Pagination.Next>
              </Pagination.Item>
            </Pagination.Content>
          </Pagination>
        </Specimen>

        <Specimen
          label="Table"
          note="The bare HeroUI table. JtsDataTable below is this plus naming, states, overflow and pagination."
          className="grid"
        >
          <Table variant="secondary">
            <Table.ScrollContainer>
              <Table.Content aria-label="Outbound queue specimen">
                <Table.Header>
                  <Table.Column id="who" isRowHeader>
                    Participant
                  </Table.Column>
                  <Table.Column id="event">Event</Table.Column>
                  <Table.Column id="waiting">Waiting</Table.Column>
                </Table.Header>
                <Table.Body>
                  {QUEUE_SAMPLE.map((row) => (
                    <Table.Row key={row.id} id={row.id}>
                      <Table.Cell>{row.who}</Table.Cell>
                      <Table.Cell>{row.event}</Table.Cell>
                      <Table.Cell className="tabular-nums">
                        {row.waiting}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </Specimen>
      </div>
    </Section>
  );
}
