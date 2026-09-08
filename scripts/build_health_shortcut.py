"""Build the native one-click health export; sign with macOS `shortcuts sign`.

Health action schema follows viticci/shortcuts-playground-plugin HEALTHKIT.md;
plist dictionaries follow cherrilang.org/compiler/file-format.html.
No network action, Health write action, or personal device identifier is included.
"""
from __future__ import annotations

import argparse
import plistlib
from pathlib import Path
from uuid import uuid4


def text(value):
    return {'Value': {'string': value}, 'WFSerializationType': 'WFTextTokenString'}


def token(output, name='Output', inline=False):
    attachment = {'OutputUUID': output, 'OutputName': name, 'Type': 'ActionOutput'}
    if inline:
        return {'Value': {'string': '\ufffc', 'attachmentsByRange': {'{0, 1}': attachment}}, 'WFSerializationType': 'WFTextTokenString'}
    return {'Value': attachment, 'WFSerializationType': 'WFTextTokenAttachment'}


def dictionary(fields):
    items = []
    for key, value in fields.items():
        nested = isinstance(value, dict) and 'WFSerializationType' not in value
        encoded = {'Value': dictionary(value), 'WFSerializationType': 'WFDictionaryFieldValue'} if nested else text(value) if isinstance(value, str) else value
        items.append({'WFItemType': 1 if nested else 0, 'WFKey': text(key), 'WFValue': encoded})
    return {'Value': {'WFDictionaryFieldValueItems': items}, 'WFSerializationType': 'WFDictionaryFieldValue'}


def build(fixture=False, mi_fitness=False):
    actions = []
    def add(identifier, **parameters):
        uid = str(uuid4()).upper()
        actions.append({'WFWorkflowActionIdentifier': 'is.workflow.actions.' + identifier,
                        'WFWorkflowActionParameters': {'UUID': uid, **parameters}})
        return uid
    add('comment', WFCommentActionText='在解锁的 iPhone 上运行，读取最近 8 天的睡眠和步数，保存到 iCloud Drive / Shortcuts / KinaWatch / health.json。KinaWatch 会更新最近 7 天并保留更早历史。首次运行请允许读取这两项健康数据。')
    if mi_fitness:
        add('comment', WFCommentActionText='先打开小米运动健康，等待 20 秒让手环连接并同步。请保持 iPhone 解锁、手环在附近。等待结束不代表同步已完成；导出后会提示今天是否仍缺睡眠记录。')
        if not fixture:
            # Bundle identity verified through Apple's lookup API, app 1493500777.
            add('openapp', WFAppIdentifier='com.xiaomi.miwatch.pro',
                WFSelectedApp={'BundleIdentifier': 'com.xiaomi.miwatch.pro', 'Name': '小米运动健康'})
            add('delay', WFDelayTime=20)
    columns = {}
    sleep_ends = None
    for kind, label in [('sleep', 'Sleep'), ('steps', 'Steps')]:
        fields = {}
        if not fixture:
            samples = add('filter.health.quantity', WFContentItemFilter={
                'Value': {'WFActionParameterFilterPrefix': 1, 'WFContentPredicateBoundedDate': False,
                          'WFActionParameterFilterTemplates': [
                              {'Bounded': True, 'Operator': 4, 'Property': 'Type', 'Removable': False,
                               'Values': {'Enumeration': {'Value': label, 'WFSerializationType': 'WFStringSubstitutableState'}}},
                              {'Bounded': True, 'Operator': 1001, 'Property': 'Start Date', 'Removable': True,
                               'Values': {'Number': '8', 'Unit': 16}}]},
                'WFSerializationType': 'WFContentPredicateTableTemplate'},
                WFContentItemLimitEnabled=False, WFContentItemSortProperty='Start Date', WFContentItemSortOrder='Oldest First')
        for key, detail in [('start', 'Start Date'), ('end', 'End Date'), ('value', 'Value'), ('source', 'Source')]:
            if fixture:
                values = {'start': '2026-09-06T23:00:00+08:00\n2026-09-07T23:00:00+08:00',
                          'end': '2026-09-07T07:00:00+08:00\n2026-09-08T07:00:00+08:00',
                          'value': '在床\n在床' if kind == 'sleep' else '120\n180',
                          'source': 'Mi Fitness\nMi Fitness'}
                raw = add('gettext', WFTextActionText=values[key])
                output = add('text.split', WFTextSeparator='New Lines', text=token(raw))
            else:
                output = add('properties.health.quantity', WFContentItemPropertyName=detail, WFInput=token(samples, 'Health Samples'))
            if key in ('start', 'end'):
                output = add('format.date', WFDate=token(output, detail, inline=True), WFDateFormatStyle='Custom', WFDateFormat="yyyy-MM-dd'T'HH:mm:ssXXXXX")
            output = add('text.combine', WFTextSeparator='New Lines', text=token(output))
            if kind == 'sleep' and key == 'end':
                sleep_ends = output
            fields[key] = token(output, 'Combined Text', inline=True)
        columns[kind] = fields
    now = add('date', WFDateActionMode='Current Date')
    formatted = add('format.date', WFDate=token(now, 'Date', inline=True), WFDateFormatStyle='Custom', WFDateFormat="yyyy-MM-dd'T'HH:mm:ssXXXXX")
    payload = add('dictionary', WFItems=dictionary({'schema': 'kinawatch.health.v1', 'exported_at': token(formatted, 'Formatted Date', inline=True), **columns}))
    output = add('detect.text', WFInput=token(payload, 'Dictionary'))
    output = add('setitemname', WFInput=token(output, 'Text'), WFName='fixture.json' if fixture else 'health.json')
    add('documentpicker.save', WFInput=token(output, 'Renamed Item'), WFFileStorageService='iCloud Drive', WFAskWhereToSave=False,
        WFFileDestinationPath='KinaWatch/fixture.json' if fixture else 'KinaWatch/health.json', WFSaveFileOverwrite=True)
    message = '健康同步文件已生成。iCloud 到达 Mac 后，打开 KinaWatch 或点击“检查同步”。'
    if mi_fitness:
        today = add('format.date', WFDate=token(now, 'Date', inline=True),
                    WFDateFormatStyle='Custom', WFDateFormat='yyyy-MM-dd')
        group = str(uuid4()).upper()
        add('conditional', GroupingIdentifier=group, WFControlFlowMode=0,
            WFInput={'Type': 'Variable', 'Variable': token(sleep_ends, 'Combined Text')},
            WFCondition=99, WFConditionalActionString=token(today, 'Formatted Date', inline=True))
        add('gettext', WFTextActionText=message)
        add('conditional', GroupingIdentifier=group, WFControlFlowMode=1)
        add('gettext', WFTextActionText='已导出已有健康数据，但 Apple 健康中仍缺少今天结束的睡眠记录。请在小米运动健康确认手环同步完成，稍后重试。')
        result = add('conditional', GroupingIdentifier=group, WFControlFlowMode=2)
        message = token(result, 'If Result', inline=True)
    if not fixture:
        add('notification', WFNotificationActionTitle='KinaWatch', WFNotificationActionBody=message, WFNotificationActionSound=False)
    name = 'KinaWatch 格式验证' if fixture else 'KinaWatch 健康同步-v3' if mi_fitness else 'KinaWatch 健康同步'
    return {'WFWorkflowName': name, 'WFWorkflowActions': actions, 'WFWorkflowClientVersion': '4033.0.4.3',
            'WFWorkflowMinimumClientVersion': 900, 'WFWorkflowMinimumClientVersionString': '900',
            'WFWorkflowIcon': {'WFWorkflowIconStartColor': 12341759, 'WFWorkflowIconGlyphNumber': 61440},
            'WFWorkflowInputContentItemClasses': [], 'WFWorkflowOutputContentItemClasses': [],
            'WFWorkflowHasOutputFallback': False, 'WFWorkflowTypes': [], 'WFWorkflowImportQuestions': [],
            'WFWorkflowIsDisabledOnLockScreen': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('output', type=Path)
    parser.add_argument('--fixture', action='store_true', help='Synthetic data only, for validating native serialization on macOS.')
    parser.add_argument('--mi-fitness', action='store_true', help='Open Mi Fitness, allow 20 seconds for sync, and report missing sleep for today.')
    args = parser.parse_args()
    args.output.write_bytes(plistlib.dumps(build(args.fixture, args.mi_fitness), fmt=plistlib.FMT_XML))
