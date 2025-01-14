import { calendar_v3, GaxiosPromise } from '@googleapis/calendar';
import { isFuture } from 'date-fns';

import { isProd, isTest } from '../config';
import { sendInvalidTokenNotification } from '../util/calendar';
import { createCalendarApi, invalidateToken } from './InitGoogle';
interface CalendarData {
  summary: string;
  description: string;
}

interface EventData {
  start?: Date;
  end?: Date;
  summary?: string;
  attendees?: calendar_v3.Schema$EventAttendee[];
  status?: 'cancelled';
}

interface CalendarId {
  calendarId: string;
}

interface EventIds {
  calendarId: string;
  calendarEventId: string;
}

interface Attendee {
  attendeeEmail: string;
}

const tokenErrors = [
  'Invalid Credentials',
  'invalid_grant',
  'No access, refresh token, API key or refresh handler callback is set.',
  'No refresh token is set.',
];

function errorHandler(err: unknown) {
  if (err instanceof Error && tokenErrors.includes(err.message)) {
    console.error('Marking token as invalid');
    invalidateToken();
    sendInvalidTokenNotification();
  }
}

async function callWithHandler<T>(
  func: () => GaxiosPromise<T>,
): GaxiosPromise<T> {
  try {
    return await func();
  } catch (err) {
    errorHandler(err);
    throw err;
  }
}

function createEventRequestBody(
  { attendees, start, end, summary }: EventData,
  oldEventData?: calendar_v3.Schema$Event,
): calendar_v3.Schema$Event {
  // Only send emails to attendees when creating or updating events in
  // the future.
  const updateAttendees = (!start || isFuture(start)) && !!attendees;
  return {
    ...oldEventData,
    ...(start && { start: { dateTime: start.toISOString() } }),
    ...(end && { end: { dateTime: end.toISOString() } }),
    ...(summary && { summary }),
    // Since Google will send emails to these addresses, we don't want to
    // accidentally send emails in testing.
    ...(updateAttendees && {
      attendees: isProd() || isTest() ? attendees : [],
    }),
    guestsCanSeeOtherGuests: false,
    guestsCanInviteOthers: false,
  };
}

async function getAndUpdateEvent(
  { calendarId, calendarEventId: eventId }: EventIds,
  updater: (oldEvent: calendar_v3.Schema$Event) => calendar_v3.Schema$Event,
) {
  const calendarApi = await createCalendarApi();

  const { data: oldEventData } = await callWithHandler(() =>
    calendarApi.events.get({
      calendarId,
      eventId,
    }),
  );

  return await callWithHandler(() =>
    calendarApi.events.update({
      calendarId,
      eventId,
      sendUpdates: 'all',
      requestBody: updater(oldEventData),
    }),
  );
}

async function updateAttendees(
  { calendarId, calendarEventId }: EventIds,
  updateAttendees: (
    attendees?: calendar_v3.Schema$EventAttendee[],
  ) => calendar_v3.Schema$EventAttendee[],
) {
  function updater(oldEventData: calendar_v3.Schema$Event) {
    const canUpdateAttendees =
      oldEventData.start?.dateTime &&
      isFuture(new Date(oldEventData.start.dateTime));
    const attendees = canUpdateAttendees
      ? updateAttendees(oldEventData.attendees)
      : oldEventData.attendees;

    return createEventRequestBody(
      {
        attendees,
      },
      oldEventData,
    );
  }

  return getAndUpdateEvent({ calendarId, calendarEventId }, updater);
}

function removeFromAttendees(email: string) {
  return (attendees: calendar_v3.Schema$EventAttendee[]) =>
    attendees.filter((attendee) => attendee.email !== email);
}

function addToAttendees(email: string) {
  return (attendees: calendar_v3.Schema$EventAttendee[] = []) =>
    attendees.concat({ email });
}

function cancelAttendance(email: string) {
  return (attendees: calendar_v3.Schema$EventAttendee[] = []) =>
    attendees.map((attendee) =>
      attendee.email === email
        ? { ...attendee, responseStatus: 'declined' }
        : attendee,
    );
}

export async function createCalendar({ summary, description }: CalendarData) {
  const calendarApi = await createCalendarApi();

  const { data } = await callWithHandler(() =>
    calendarApi.calendars.insert({
      requestBody: {
        summary,
        description,
      },
    }),
  );

  return data;
}

export async function createCalendarEvent(
  { calendarId }: CalendarId,
  eventData: EventData,
) {
  const calendarApi = await createCalendarApi();

  const { data } = await callWithHandler(() =>
    calendarApi.events.insert({
      calendarId,
      sendUpdates: 'all',
      requestBody: createEventRequestBody(eventData),
    }),
  );
  return { calendarEventId: data.id };
}

// To be used to update event, but not the attendees.
export async function updateCalendarEventDetails(
  { calendarId, calendarEventId }: EventIds,
  eventUpdateData: EventData,
) {
  const updater = (oldEventData: calendar_v3.Schema$Event) =>
    createEventRequestBody(eventUpdateData, oldEventData);

  await getAndUpdateEvent({ calendarId, calendarEventId }, updater);
}

export async function removeEventAttendee(
  { calendarId, calendarEventId }: EventIds,
  { attendeeEmail }: Attendee,
) {
  return await updateAttendees(
    { calendarId, calendarEventId },
    removeFromAttendees(attendeeEmail),
  );
}

export async function cancelEventAttendance(
  { calendarId, calendarEventId }: EventIds,
  { attendeeEmail }: Attendee,
) {
  return await updateAttendees(
    { calendarId, calendarEventId },
    cancelAttendance(attendeeEmail),
  );
}

export async function addEventAttendee(
  { calendarId, calendarEventId }: EventIds,
  { attendeeEmail }: Attendee,
) {
  return await updateAttendees(
    { calendarId, calendarEventId },
    addToAttendees(attendeeEmail),
  );
}

export async function deleteCalendarEvent({
  calendarId,
  calendarEventId: eventId,
}: EventIds) {
  const calendarApi = await createCalendarApi();

  await callWithHandler(() =>
    calendarApi.events.delete({
      calendarId,
      eventId,
      sendUpdates: 'all',
    }),
  );
}
