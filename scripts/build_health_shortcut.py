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


def build(fixture=False):
    actions = []
    def add(identifier, **parameters):
        uid = str(uuid4()).upper()
        actions.append({'WFWorkflowActionIdentifier': 'is.workflow.actions.' + identifier,
                        'WFWorkflowActionParameters': {'UUID': uid, **parameters}})
        return uid
    add('comment', WFCommentActionText='在解锁的 iPhone 上运行，读取最近 8 天的睡眠和步数，保存到 iCloud Drive / Shortcuts / KinaWatch / health.json。KinaWatch 会更新最近 7 天并保留更早历史。首次运行请允许读取这两项健康数据。')
    columns = {}
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
            fields[key] = token(output, 'Combined Text', inline=True)
        columns[kind] = fields
    now = add('date', WFDateActionMode='Current Date')
    formatted = add('format.date', WFDate=token(now, 'Date', inline=True), WFDateFormatStyle='Custom', WFDateFormat="yyyy-MM-dd'T'HH:mm:ssXXXXX")
    payload = add('dictionary', WFItems=dictionary({'schema': 'kinawatch.health.v1', 'exported_at': token(formatted, 'Formatted Date', inline=True), **columns}))
    output = add('detect.text', WFInput=token(payload, 'Dictionary'))
    output = add('setitemname', WFInput=token(output, 'Text'), WFName='fixture.json' if fixture else 'health.json')
    add('documentpicker.save', WFInput=token(output, 'Renamed Item'), WFFileStorageService='iCloud Drive', WFAskWhereToSave=False,
        WFFileDestinationPath='KinaWatch/fixture.json' if fixture else 'KinaWatch/health.json', WFSaveFileOverwrite=True)
    if not fixture:
        add('notification', WFNotificationActionTitle='KinaWatch', WFNotificationActionBody='健康同步文件已生成。iCloud 到达 Mac 后，打开 KinaWatch 或点击“检查同步”。', WFNotificationActionSound=False)
    name = 'KinaWatch 格式验证' if fixture else 'KinaWatch 健康同步'
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
    args = parser.parse_args()
    args.output.write_bytes(plistlib.dumps(build(args.fixture), fmt=plistlib.FMT_XML))
