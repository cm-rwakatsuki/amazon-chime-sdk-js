// Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  AsyncScheduler,
  AudioVideoFacade,
  AudioVideoObserver,
  DefaultActiveSpeakerPolicy,
  DefaultAudioMixController,
  DefaultBrowserBehavior,
  DefaultDeviceController,
  DefaultMeetingSession,
  DefaultModality,
  Device,
  Logger,
  LogLevel,
  MeetingSession,
  MeetingSessionConfiguration,
  MeetingSessionPOSTLogger,
  MeetingSessionStatus,
  MeetingSessionStatusCode,
  PingPongObserver,
  TimeoutScheduler
} from '../../../../src/index';
import ClientMetricReport from "../../../../src/clientmetricreport/ClientMetricReport";

class TestSound {
  constructor(
    sinkId: string | null,
    frequency: number = 440,
    durationSec: number = 1,
    rampSec: number = 0.1,
    maxGainValue: number = 0.1
  ) {
    // @ts-ignore
    const audioContext: AudioContext = new (window.AudioContext || window.webkitAudioContext)();
    const gainNode = audioContext.createGain();
    gainNode.gain.value = 0;
    const oscillatorNode = audioContext.createOscillator();
    oscillatorNode.frequency.value = frequency;
    oscillatorNode.connect(gainNode);
    const destinationStream = audioContext.createMediaStreamDestination();
    gainNode.connect(destinationStream);
    const currentTime = audioContext.currentTime;
    const startTime = currentTime + 0.1;
    gainNode.gain.linearRampToValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(maxGainValue, startTime + rampSec);
    gainNode.gain.linearRampToValueAtTime(maxGainValue, startTime + rampSec + durationSec);
    gainNode.gain.linearRampToValueAtTime(0, startTime + rampSec * 2 + durationSec);
    oscillatorNode.start();
    const audioMixController = new DefaultAudioMixController();
    // @ts-ignore
    audioMixController.bindAudioDevice({deviceId: sinkId});
    audioMixController.bindAudioElement(new Audio());
    audioMixController.bindAudioStream(destinationStream.stream);
    new TimeoutScheduler((rampSec * 2 + durationSec + 1) * 1000).start(() => {
      audioContext.close();
    });
    audioContext.resume().then(() => {
      console.log('Playback resumed successfully');
    });
  }
}


export class DemoMeetingApp implements AudioVideoObserver, PingPongObserver {
  static readonly DID: string = '+17035550122';
  static readonly BASE_URL: string = [location.protocol, '//', location.host, location.pathname.replace(/\/*$/, '/').replace('/v2', '')].join('');
  static testVideo: string = 'https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.360p.vp9.webm';
  static readonly LOGGER_BATCH_SIZE: number = 85;
  static readonly LOGGER_INTERVAL_MS: number = 2000;
  static readonly DATA_MESSAGE_TOPIC: string = "chat";
  static readonly DATA_MESSAGE_LIFETIME_MS: number = 300000;

  showActiveSpeakerScores = false;
  activeSpeakerLayout = true;
  meeting: string | null = null;
  name: string | null = null;
  voiceConnectorId: string | null = null;
  sipURI: string | null = null;
  region: string | null = null;
  meetingSession: MeetingSession | null = null;
  audioVideo: AudioVideoFacade | null = null;
  canStartLocalVideo: boolean = true;
  defaultBrowserBehaviour: DefaultBrowserBehavior;
  // eslint-disable-next-line
  roster: any = {};
  metricReport: any = {};
  sessionMeetingId: string = '';
  sessionAttendeeId: string = '';
  cameraDeviceIds: string[] = [];
  microphoneDeviceIds: string[] = [];
  logger: Logger = null;
  buttonStates: { [key: string]: boolean } = {};
  instanceId: string | null = null;
  loadTestStartTime: string | null = null;
  loadTestSessionName: string | null = null;

  // feature flags
  enableWebAudio = false;
  enableUnifiedPlanForChromiumBasedBrowsers = false;
  enableSimulcast = false;
  private meetingActive: boolean = false;

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).app = this;
    this.initEventListeners();
    this.initParameters();
    if (this.isRecorder() || this.isBroadcaster()) {
      new AsyncScheduler().start(async () => {
        this.meeting = new URL(window.location.href).searchParams.get('m');
        this.name = this.isRecorder() ? '«Meeting Recorder»' : '«Meeting Broadcaster»';
        await this.authenticate();
        await this.join();
        this.displayButtonStates();
        this.switchToFlow('flow-meeting');
      });
    } else {
      this.switchToFlow('flow-authenticate');
    }

    const queryString = window.location.search;
    const urlParams = new URLSearchParams(queryString);
    const meetingInfo = JSON.parse(urlParams.get('meetingInfo'));
    const attendeeInfo = JSON.parse(urlParams.get('attendeeInfo'));
    this.sessionMeetingId = meetingInfo.MeetingId;
    this.sessionAttendeeId = attendeeInfo.AttendeeId;
    (document.getElementById('inputMeeting') as HTMLInputElement).value = this.sessionMeetingId;
    (document.getElementById('inputName') as HTMLInputElement).value = this.sessionAttendeeId;

    this.instanceId = new URL(window.location.href).searchParams.get('instanceId');
    this.loadTestStartTime = new URL(window.location.href).searchParams.get('loadTestStartTime');
    this.loadTestSessionName = new URL(window.location.href).searchParams.get('loadTestSessionName');

    const timeToWaitMS = new URL(window.location.href).searchParams.get('timeToWaitMS');
    const timeToWait = parseInt(timeToWaitMS, 10);
    const meetingLeaveAfterMs = new URL(window.location.href).searchParams.get('meetingLeaveAfterMs');
    const meetingLeaveAfter = parseInt(meetingLeaveAfterMs, 10);
    setTimeout(() => {
      document.getElementById('authenticate').click();
      this.sendStatus('MeetingJoin', 1);
      document.getElementById('authenticate').click();
    }, timeToWait);

    setTimeout(() => {
      document.getElementById('button-meeting-leave').click();
    }, meetingLeaveAfter);
  }

  initParameters(): void {
    const meeting = new URL(window.location.href).searchParams.get('m');
    if (meeting) {
      (document.getElementById('inputMeeting') as HTMLInputElement).value = meeting;
      (document.getElementById('inputName') as HTMLInputElement).focus();
    } else {
      (document.getElementById('inputMeeting') as HTMLInputElement).focus();
    }
    this.defaultBrowserBehaviour = new DefaultBrowserBehavior();
  }

  initEventListeners(): void {
    document.getElementById('form-authenticate').addEventListener('submit', e => {
      e.preventDefault();
      this.meeting = (document.getElementById('inputMeeting') as HTMLInputElement).value;
      this.name = (document.getElementById('inputName') as HTMLInputElement).value;
      this.region = 'us-east-1';
      new AsyncScheduler().start(
        async (): Promise<void> => {
          let chimeMeetingId: string = '';
          this.showProgress('progress-authenticate');
          try {
            chimeMeetingId = await this.authenticate();
          } catch (error) {
            this.log(error);
            this.log(error.message);
            (document.getElementById(
              'failed-meeting'
            ) as HTMLDivElement).innerText = `Meeting ID: ${this.meeting}`;
            (document.getElementById('failed-meeting-error') as HTMLDivElement).innerText =
              error.message;
            this.switchToFlow('flow-failed-meeting');
            return;
          }
          (document.getElementById(
            'meeting-id'
          ) as HTMLSpanElement).innerText = `${this.meeting} (${this.region})`;
          (document.getElementById(
            'chime-meeting-id'
          ) as HTMLSpanElement).innerText = `Meeting ID: ${chimeMeetingId}`;
          (document.getElementById(
            'desktop-attendee-id'
          ) as HTMLSpanElement).innerText = `Attendee ID: ${this.meetingSession.configuration.credentials.attendeeId}`;
          (document.getElementById('info-meeting') as HTMLSpanElement).innerText = this.meeting;
          (document.getElementById('info-name') as HTMLSpanElement).innerText = this.name;
          await new Promise(resolve => setTimeout(resolve, 2500));
          await this.join();
          await this.audioVideo.chooseVideoInputDevice(null);
          await this.audioVideo.chooseAudioInputDevice(this.audioInputSelectionToDevice('440 Hz'));
          this.displayButtonStates();
          this.switchToFlow('flow-meeting');
          await this.openAudioInputFromSelection();
          await this.openAudioOutputFromSelection();
          this.hideProgress('progress-authenticate');
        }
      );
    });

    const audioInput = document.getElementById('audio-input') as HTMLSelectElement;
    audioInput.addEventListener('change', async (_ev: Event) => {
      this.log('audio input device is changed');
      await this.openAudioInputFromSelection();
    });

    const audioOutput = document.getElementById('audio-output') as HTMLSelectElement;
    audioOutput.addEventListener('change', async (_ev: Event) => {
      this.log('audio output device is changed');
      await this.openAudioOutputFromSelection();
    });

    document.getElementById('button-test-sound').addEventListener('click', e => {
      e.preventDefault();
      const audioOutput = document.getElementById('audio-output') as HTMLSelectElement;
      new TestSound(audioOutput.value);
    });


    const buttonMeetingEnd = document.getElementById('button-meeting-end');
    buttonMeetingEnd.addEventListener('click', _e => {
      const confirmEnd = (new URL(window.location.href).searchParams.get('confirm-end')) === 'true';
      const prompt = 'Are you sure you want to end the meeting for everyone? The meeting cannot be used after ending it.';
      if (confirmEnd && !window.confirm(prompt)) {
        return;
      }
      new AsyncScheduler().start(async () => {
        (buttonMeetingEnd as HTMLButtonElement).disabled = true;
        await this.endMeeting();
        this.leave();
        (buttonMeetingEnd as HTMLButtonElement).disabled = false;
        // @ts-ignore
        window.location = window.location.pathname;
      });
    });

    const buttonMeetingLeave = document.getElementById('button-meeting-leave');
    buttonMeetingLeave.addEventListener('click', _e => {
      new AsyncScheduler().start(async () => {
        const newRosterCount = Object.keys(this.roster).length;
        if (newRosterCount === 1) {
          await this.endMeeting();
        }
        (buttonMeetingLeave as HTMLButtonElement).disabled = true;
        this.sendStatus('MeetingLeave', 1);

        this.leave();
        (buttonMeetingLeave as HTMLButtonElement).disabled = false;
        // @ts-ignore
        window.location = window.location.pathname;
      });
    });

    setInterval(() => {
      if (new Date().getMinutes() % 5 === 0 && this.meetingActive === true) {
        this.log('Sending AlivePing when minutes is multiple of 5');
        this.sendStatus('AlivePing', 1);

      }
    }, 50000);

    setInterval(() => {
      if (Object.keys(this.metricReport).length > 0) { // && timeSinceStartOfLoadTest > 5500) {
        console.log(this.metricReport);
        this.sendMetrics(this.metricReport);
      }
    }, 1000);
  }

  async sendMetrics(metrics: any): Promise<void> {
    metrics.mId = this.sessionMeetingId;
    metrics.aId = this.sessionAttendeeId;
    metrics.sId = this.loadTestSessionName;
    metrics.iId = this.instanceId;
    metrics.ltStartTime = new Date(parseInt(this.loadTestStartTime.toString()));
    const body = JSON.stringify(metrics);
    console.log(body);
    try {
      const response = await fetch(`${DemoMeetingApp.BASE_URL}send_metrics`, {
        method: 'POST',
        body
      });
      if (response.status === 200) {
        console.log('Metrics Sent');
      }
    } catch (error) {
      console.error(error.message);
    }
  }

  async sendStatus(metricName: string, metricValue: number): Promise<void> {
    const metricBody = {
      metricName: metricName,
      metricValue: metricValue
    };
      await this.sendMetrics(metricBody);
  }
  toggleButton(button: string, state?: 'on' | 'off'): boolean {
    if (state === 'on') {
      this.buttonStates[button] = true;
    } else if (state === 'off') {
      this.buttonStates[button] = false;
    } else {
      this.buttonStates[button] = !this.buttonStates[button];
    }
    this.displayButtonStates();
    return this.buttonStates[button];
  }

  isButtonOn(button: string) {
    return this.buttonStates[button];
  }

  displayButtonStates(): void {
    for (const button in this.buttonStates) {
      const element = document.getElementById(button);
      const drop = document.getElementById(`${button}-drop`);
      const on = this.buttonStates[button];
      element.classList.add(on ? 'btn-success' : 'btn-outline-secondary');
      element.classList.remove(on ? 'btn-outline-secondary' : 'btn-success');
      (element.firstElementChild as SVGElement).classList.add(on ? 'svg-active' : 'svg-inactive');
      (element.firstElementChild as SVGElement).classList.remove(
        on ? 'svg-inactive' : 'svg-active'
      );
      if (drop) {
        drop.classList.add(on ? 'btn-success' : 'btn-outline-secondary');
        drop.classList.remove(on ? 'btn-outline-secondary' : 'btn-success');
      }
    }
  }

  showProgress(id: string): void {
    (document.getElementById(id) as HTMLDivElement).style.visibility = 'visible';
  }

  hideProgress(id: string): void {
    (document.getElementById(id) as HTMLDivElement).style.visibility = 'hidden';
  }

  switchToFlow(flow: string): void {
    this.analyserNodeCallback = () => {
    };
    Array.from(document.getElementsByClassName('flow')).map(
      e => ((e as HTMLDivElement).style.display = 'none')
    );
    (document.getElementById(flow) as HTMLDivElement).style.display = 'block';

  }

  audioInputsChanged(_freshAudioInputDeviceList: MediaDeviceInfo[]): void {
    //this.populateAudioInputList();
  }

  audioOutputsChanged(_freshAudioOutputDeviceList: MediaDeviceInfo[]): void {
    //this.populateAudioOutputList();
  }

  audioInputStreamEnded(deviceId: string): void {
    this.log(`Current audio input stream from device id ${deviceId} ended.`);
  }

  videoInputStreamEnded(deviceId: string): void {
    this.log(`Current video input stream from device id ${deviceId} ended.`);
  }

  estimatedDownlinkBandwidthLessThanRequired(estimatedDownlinkBandwidthKbps: number, requiredVideoDownlinkBandwidthKbps: number): void {
    this.log(`Estimated downlink bandwidth is ${estimatedDownlinkBandwidthKbps} is less than required bandwidth for video ${requiredVideoDownlinkBandwidthKbps}`);
  }

  async createLogStream(configuration: MeetingSessionConfiguration): Promise<void> {
    const body = JSON.stringify({
      meetingId: configuration.meetingId,
      attendeeId: configuration.credentials.attendeeId,
    });
    try {
      const response = await fetch(`${DemoMeetingApp.BASE_URL}create_log_stream`, {
        method: 'POST',
        body
      });
      if (response.status === 200) {
        console.log('Log stream created');
      }
    } catch (error) {
      console.error(error.message);
    }
  }

  async getLoadTestStatus() {
    setInterval(async () => {
      try {
        const url = DemoMeetingApp.BASE_URL + 'get_load_test_status';
        console.error('11111 ', url);
        const response = await fetch(url, {method: 'GET'});
        console.error('010101 ', response);
        console.error('3333 ', response.body);
        console.error('4444 ',response.body.toString());
        if (response.status === 200) {
          const loadTestStatusResponse = await response.json();
          console.error('5555 ',loadTestStatusResponse);
          console.error('6666 ',loadTestStatusResponse.LoadTestStatus);
          console.error('7777 ',loadTestStatusResponse.LoadTestStatus === 'Abort');
          if (loadTestStatusResponse.LoadTestStatus === 'Abort') {
            const buttonMeetingEnd = document.getElementById('button-meeting-end');
            buttonMeetingEnd.click();
          }
        }
      } catch (error) {
        console.warn('[getLoadTestStatus] ' + error.message);
      }
    }, 2000);
  }

  async initializeMeetingSession(configuration: MeetingSessionConfiguration): Promise<void> {
    await this.getLoadTestStatus();
    const logLevel = LogLevel.INFO;
    await this.createLogStream(configuration);
    this.logger = new MeetingSessionPOSTLogger(
      'SDK',
      configuration,
      DemoMeetingApp.LOGGER_BATCH_SIZE,
      DemoMeetingApp.LOGGER_INTERVAL_MS,
      `${DemoMeetingApp.BASE_URL}logs`,
      logLevel
    );
    const deviceController = new DefaultDeviceController(this.logger);
    configuration.enableWebAudio = this.enableWebAudio;
    configuration.enableUnifiedPlanForChromiumBasedBrowsers = this.enableUnifiedPlanForChromiumBasedBrowsers;
    configuration.attendeePresenceTimeoutMs = 5000;
    configuration.enableSimulcastForUnifiedPlanChromiumBasedBrowsers = this.enableSimulcast;
    this.meetingSession = new DefaultMeetingSession(configuration, this.logger, deviceController);
    this.audioVideo = this.meetingSession.audioVideo;

    this.audioVideo.addDeviceChangeObserver(this);
    await this.populateAllDeviceLists();
    this.setupMuteHandler();
    this.setupCanUnmuteHandler();
    this.setupSubscribeToAttendeeIdPresenceHandler();
    this.audioVideo.addObserver(this);
  }

  setClickHandler(elementId: string, f: () => void): void {
    document.getElementById(elementId).addEventListener('click', () => {
      f();
    });
  }

  async metricsDidReceive(clientMetricReport: ClientMetricReport): Promise<void> {
    const metricReport = clientMetricReport.getObservableMetrics();
    if (typeof metricReport.audioDecoderLoss === 'number' && !isNaN(metricReport.audioDecoderLoss)) {
      (document.getElementById('audioDecoderLoss') as HTMLSpanElement).innerText = String(metricReport.audioDecoderLoss);
    }
    if (typeof metricReport.audioPacketsReceived === 'number' && !isNaN(metricReport.audioPacketsReceived)) {
      (document.getElementById('audioPacketsReceived') as HTMLSpanElement).innerText = String(metricReport.audioPacketsReceived);
    }
    if (typeof metricReport.audioPacketsReceivedFractionLoss === 'number' && !isNaN(metricReport.audioPacketsReceivedFractionLoss)) {
      (document.getElementById('audioPacketsReceivedFractionLoss') as HTMLSpanElement).innerText = String(metricReport.audioPacketsReceivedFractionLoss);
    }
    if (typeof metricReport.audioSpeakerDelayMs === 'number' && !isNaN(metricReport.audioSpeakerDelayMs)) {
      (document.getElementById('audioSpeakerDelayMs') as HTMLSpanElement).innerText = String(metricReport.audioSpeakerDelayMs);
    }
    if (typeof metricReport.availableReceiveBandwidth === 'number' && !isNaN(metricReport.availableReceiveBandwidth)) {
      (document.getElementById('availableReceiveBandwidth') as HTMLSpanElement).innerText = String(metricReport.availableReceiveBandwidth);
    }
    if (typeof metricReport.availableSendBandwidth === 'number' && !isNaN(metricReport.availableSendBandwidth)) {
      (document.getElementById('availableSendBandwidth') as HTMLSpanElement).innerText = String(metricReport.availableSendBandwidth);
    }

    if (typeof metricReport.audioPacketsReceived === 'number') {
      delete metricReport.availableOutgoingBitrate;
      delete metricReport.availableIncomingBitrate;
      delete metricReport.nackCountReceivedPerSecond;
      delete metricReport.googNackCountReceivedPerSecond;
      delete metricReport.videoUpstreamBitrate;
      delete metricReport.videoPacketSentPerSecond;
      delete metricReport.availableSendBandwidth;
      this.metricReport = {
        metricBody: metricReport,
      };
      //console.log(this.metricReport);
    } else {
      this.log(`{'...empty...'}`);
    }
  }

  async join(): Promise<void> {
    window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
      this.log(event.reason);
    });
    await this.openAudioInputFromSelection();
    await this.openAudioOutputFromSelection();
    this.audioVideo.start();
    await this.audioVideo.chooseAudioInputDevice(this.audioInputSelectionToDevice('440 Hz'));
  }

  leave(): void {
    this.audioVideo.stop();
    this.roster = {};
  }

  setupMuteHandler(): void {
    const handler = (isMuted: boolean): void => {
      this.log(`muted = ${isMuted}`);
    };
    this.audioVideo.realtimeSubscribeToMuteAndUnmuteLocalAudio(handler);
    const isMuted = this.audioVideo.realtimeIsLocalAudioMuted();
    handler(isMuted);
  }

  setupCanUnmuteHandler(): void {
    const handler = (canUnmute: boolean): void => {
      this.log(`canUnmute = ${canUnmute}`);
    };
    this.audioVideo.realtimeSubscribeToSetCanUnmuteLocalAudio(handler);
    handler(this.audioVideo.realtimeCanUnmuteLocalAudio());
  }

  updateRoster(): void {
    const roster = document.getElementById('roster');
    const newRosterCount = Object.keys(this.roster).length;
    while (roster.getElementsByTagName('li').length < newRosterCount) {
      const li = document.createElement('li');
      li.className = 'list-group-item d-flex justify-content-between align-items-center';
      li.appendChild(document.createElement('span'));
      li.appendChild(document.createElement('span'));
      roster.appendChild(li);
    }
    while (roster.getElementsByTagName('li').length > newRosterCount) {
      roster.removeChild(roster.getElementsByTagName('li')[0]);
    }
    const entries = roster.getElementsByTagName('li');
    let i = 0;
    for (const attendeeId in this.roster) {
      const spanName = entries[i].getElementsByTagName('span')[0];
      const spanStatus = entries[i].getElementsByTagName('span')[1];
      let statusClass = 'badge badge-pill ';
      let statusText = '\xa0'; // &nbsp
      if (this.roster[attendeeId].signalStrength < 1) {
        statusClass += 'badge-warning';
      } else if (this.roster[attendeeId].signalStrength === 0) {
        statusClass += 'badge-danger';
      } else if (this.roster[attendeeId].muted) {
        statusText = 'MUTED';
        statusClass += 'badge-secondary';
      } else if (this.roster[attendeeId].active) {
        statusText = 'SPEAKING';
        statusClass += 'badge-success';
      } else if (this.roster[attendeeId].volume > 0) {
        statusClass += 'badge-success';
      }
      this.updateProperty(spanName, 'innerText', this.roster[attendeeId].name);
      this.updateProperty(spanStatus, 'innerText', statusText);
      this.updateProperty(spanStatus, 'className', statusClass);
      i++;
    }
  }

  updateProperty(obj: any, key: string, value: string) {
    if (value !== undefined && obj[key] !== value) {
      obj[key] = value;
    }
  }

  setupSubscribeToAttendeeIdPresenceHandler(): void {
    const handler = (attendeeId: string, present: boolean, externalUserId: string, dropped: boolean): void => {
      this.log(`${attendeeId} present = ${present} (${externalUserId})`);
      const isContentAttendee = new DefaultModality(attendeeId).hasModality(DefaultModality.MODALITY_CONTENT);
      if (!present) {
        delete this.roster[attendeeId];
        this.updateRoster();
        this.log(`${attendeeId} dropped = ${dropped} (${externalUserId})`);
        return;
      }
      if (!this.roster[attendeeId]) {
        this.roster[attendeeId] = {
          name: (externalUserId.split('#').slice(-1)[0]) + (isContentAttendee ? ' «Content»' : ''),
        };
      }
      this.audioVideo.realtimeSubscribeToVolumeIndicator(
        attendeeId,
        async (
          attendeeId: string,
          volume: number | null,
          muted: boolean | null,
          signalStrength: number | null
        ) => {
          if (!this.roster[attendeeId]) {
            return;
          }
          if (volume !== null) {
            this.roster[attendeeId].volume = Math.round(volume * 100);
          }
          if (muted !== null) {
            this.roster[attendeeId].muted = muted;
          }
          if (signalStrength !== null) {
            this.roster[attendeeId].signalStrength = Math.round(signalStrength * 100);
          }
          this.updateRoster();
        }
      );
    };
    this.audioVideo.realtimeSubscribeToAttendeeIdPresence(handler);
    const activeSpeakerHandler = (attendeeIds: string[]): void => {
      for (const attendeeId in this.roster) {
        this.roster[attendeeId].active = false;
      }
      for (const attendeeId of attendeeIds) {
        if (this.roster[attendeeId]) {
          this.roster[attendeeId].active = true;
          break; // only show the most active speaker
        }
      }
    };
    this.audioVideo.subscribeToActiveSpeakerDetector(
      new DefaultActiveSpeakerPolicy(),
      activeSpeakerHandler,
      (scores: { [attendeeId: string]: number }) => {
        for (const attendeeId in scores) {
          if (this.roster[attendeeId]) {
            this.roster[attendeeId].score = scores[attendeeId];
          }
        }
        this.updateRoster();
      },
      this.showActiveSpeakerScores ? 100 : 0,
    );
  }


  async getStatsForOutbound(id: string): Promise<void> {
    const videoElement = document.getElementById(id) as HTMLVideoElement;
    const stream = videoElement.srcObject as MediaStream;
    const track = stream.getVideoTracks()[0];
    let basicReports: { [id: string]: number } = {};

    let reports = await this.audioVideo.getRTCPeerConnectionStats(track);
    let duration: number;

    reports.forEach(report => {
      if (report.type === 'outbound-rtp') {
        // remained to be calculated
        this.log(`${id} is bound to ssrc ${report.ssrc}`);
        basicReports['bitrate'] = report.bytesSent;
        basicReports['width'] = report.frameWidth;
        basicReports['height'] = report.frameHeight;
        basicReports['fps'] = report.framesEncoded;
        duration = report.timestamp;
      }
    });

    await new TimeoutScheduler(1000).start(() => {
      this.audioVideo.getRTCPeerConnectionStats(track).then((reports) => {
        reports.forEach(report => {
          if (report.type === 'outbound-rtp') {
            duration = report.timestamp - duration;
            duration = duration / 1000;
            // remained to be calculated
            basicReports['bitrate'] = Math.trunc((report.bytesSent - basicReports['bitrate']) * 8 / duration);
            basicReports['width'] = report.frameWidth;
            basicReports['height'] = report.frameHeight;
            basicReports['fps'] = Math.trunc((report.framesEncoded - basicReports['fps']) / duration);
            //this.log(JSON.stringify(basicReports));
          }
        });
      });
    });
  }

  // eslint-disable-next-line
  async joinMeeting(): Promise<any> {
    const response = await fetch(
      `${DemoMeetingApp.BASE_URL}join?title=${encodeURIComponent(this.meeting)}&name=${encodeURIComponent(this.name)}&region=${encodeURIComponent(this.region)}`,
      {
        method: 'POST',
      }
    );
    const json = await response.json();
    if (json.error) {
      throw new Error(`Server error: ${json.error}`);
    }
    return json;
  }

  async getMeetingAttendeeInfo(): Promise<any> {

    const meetingInfo = new URL(window.location.href).searchParams.get('meetingInfo');

    const attendeeInfo = new URL(window.location.href).searchParams.get('attendeeInfo');

    console.log(meetingInfo)
    console.log(attendeeInfo)
    return {
      JoinInfo:
        {
          Meeting: JSON.parse(meetingInfo),
          Attendee: JSON.parse(attendeeInfo),
        },
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async endMeeting(): Promise<any> {
    await fetch(`${DemoMeetingApp.BASE_URL}end?title=${encodeURIComponent(this.meeting)}`, {
      method: 'POST',
    });
    this.sendStatus('MeetingDelete', 1);

  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getAttendee(attendeeId: string): Promise<any> {
    const response = await fetch(`${DemoMeetingApp.BASE_URL}attendee?title=${encodeURIComponent(this.meeting)}&attendee=${encodeURIComponent(attendeeId)}`);
    const json = await response.json();
    if (json.error) {
      throw new Error(`Server error: ${json.error}`);
    }
    return json;
  }

  populateDeviceList(
    elementId: string,
    genericName: string,
    devices: MediaDeviceInfo[],
    additionalOptions: string[]
  ): void {
    const list = document.getElementById(elementId) as HTMLSelectElement;
    while (list.firstElementChild) {
      list.removeChild(list.firstElementChild);
    }
    for (let i = 0; i < devices.length; i++) {
      const option = document.createElement('option');
      list.appendChild(option);
      option.text = devices[i].label || `${genericName} ${i + 1}`;
      option.value = devices[i].deviceId;
    }
    if (additionalOptions.length > 0) {
      const separator = document.createElement('option');
      separator.disabled = true;
      separator.text = '──────────';
      list.appendChild(separator);
      for (const additionalOption of additionalOptions) {
        const option = document.createElement('option');
        list.appendChild(option);
        option.text = additionalOption;
        option.value = additionalOption;
      }
    }
    if (!list.firstElementChild) {
      const option = document.createElement('option');
      option.text = 'Device selection unavailable';
      list.appendChild(option);
    }
  }

  async populateAllDeviceLists(): Promise<void> {
  }

  async populateAudioInputList(): Promise<void> {
  }

  private analyserNodeCallback = () => {
  };

  async openAudioInputFromSelection(): Promise<void> {
    const audioInput = document.getElementById('audio-input') as HTMLSelectElement;
    await this.audioVideo.chooseAudioInputDevice(
      this.audioInputSelectionToDevice(audioInput.value)
    );
    this.startAudioPreview();
  }

  setAudioPreviewPercent(percent: number): void {
    const audioPreview = document.getElementById('audio-preview');
    this.updateProperty(audioPreview.style, 'transitionDuration', '33ms');
    this.updateProperty(audioPreview.style, 'width', `${percent}%`);
    if (audioPreview.getAttribute('aria-valuenow') !== `${percent}`) {
      audioPreview.setAttribute('aria-valuenow', `${percent}`);
    }
  }


  startAudioPreview(): void {
    this.setAudioPreviewPercent(0);
    const analyserNode = this.audioVideo.createAnalyserNodeForAudioInput();
    if (!analyserNode) {
      return;
    }
    if (!analyserNode.getByteTimeDomainData) {
      document.getElementById('audio-preview').parentElement.style.visibility = 'hidden';
      return;
    }
    const data = new Uint8Array(analyserNode.fftSize);
    let frameIndex = 0;
    this.analyserNodeCallback = () => {
      if (frameIndex === 0) {
        analyserNode.getByteTimeDomainData(data);
        const lowest = 0.01;
        let max = lowest;
        for (const f of data) {
          max = Math.max(max, (f - 128) / 128);
        }
        let normalized = (Math.log(lowest) - Math.log(max)) / Math.log(lowest);
        let percent = Math.min(Math.max(normalized * 100, 0), 100);
        this.setAudioPreviewPercent(percent);
      }
      frameIndex = (frameIndex + 1) % 2;
      requestAnimationFrame(this.analyserNodeCallback);
    };
    requestAnimationFrame(this.analyserNodeCallback);
  }

  async openAudioOutputFromSelection(): Promise<void> {
    const audioOutput = document.getElementById('audio-output') as HTMLSelectElement;
    await this.audioVideo.chooseAudioOutputDevice(audioOutput.value);
    const audioMix = document.getElementById('meeting-audio') as HTMLAudioElement;
    await this.audioVideo.bindAudioElement(audioMix);
  }

  private audioInputSelectionToDevice(value: string): Device {
    if (this.isRecorder() || this.isBroadcaster()) {
      return null;
    }
    if (value === '440 Hz') {
      return DefaultDeviceController.synthesizeAudioDevice(440);
    } else if (value === 'None') {
      return null;
    }
    return value;
  }

  isRecorder(): boolean {
    return (new URL(window.location.href).searchParams.get('record')) === 'true';
  }

  isBroadcaster(): boolean {
    return (new URL(window.location.href).searchParams.get('broadcast')) === 'true';
  }

  async authenticate(): Promise<string> {
    let joinInfo2 = (await this.getMeetingAttendeeInfo()).JoinInfo;
    console.log('joinInfo 22222 &&&&& ', joinInfo2)
    const configuration = new MeetingSessionConfiguration(joinInfo2.Meeting, joinInfo2.Attendee);
    await this.initializeMeetingSession(configuration);
    const url = new URL(window.location.href);
    url.searchParams.set('m', this.meeting);
    history.replaceState({}, `${this.meeting}`, url.toString());
    return configuration.meetingId;
  }

  log(str: string): void {
    if (this.logger !== null) {
      this.logger.info(str);
    }
    console.log(`[DEMO] ${str}`);
  }

  audioVideoDidStartConnecting(reconnecting: boolean): void {
    if (reconnecting === true) {
      this.log('ReconnectingSession');
      this.sendStatus('ReconnectingSession', 1);
    } else {
      this.log('ConnectingSession');
      this.sendStatus('ConnectingSession', 1);
    }
  }

  audioVideoDidStart(): void {
    this.log('MeetingStarted');
    this.meetingActive = true;
    this.sendStatus('MeetingStarted', 1);
  }

  audioVideoDidStop(sessionStatus: MeetingSessionStatus): void {
    this.log(`SessionStopped from ${JSON.stringify(sessionStatus)}`);
    const statusCode = sessionStatus.statusCode();
    this.meetingActive = false;
    this.sendStatus('StatusCode-' + statusCode, 1);
    this.log('StatusCode: ' + statusCode + 'instanceId: ' + this.instanceId);
    if (sessionStatus.statusCode() === MeetingSessionStatusCode.AudioCallEnded) {
      this.log(`meeting ended`);
    }
  }

  connectionDidBecomePoor(): void {
    this.log('connection is poor');
  }


  connectionDidBecomeGood(): void {
    this.log('connection is good now');
  }

  didReceivePong() {
  }

}

window.addEventListener('load', () => {
  new DemoMeetingApp();
});