import os
import sys
import json
import base64
from io import BytesIO

import numpy as np
import pandas as pd

MOOD_V2_CATEGORIES = ['euforico', 'sereno', 'arrabbiato', 'malinconico', 'neutrale']
MOOD_V2_WITH_UNKNOWN = MOOD_V2_CATEGORIES + ['sconosciuto']


def add_missing_mood_columns(df, mood_columns):
    for mood in mood_columns:
        if mood not in df.columns:
            df[mood] = 0
    return df


def read_json(path_or_buf):
    # Leggi il JSON senza specificare dtype per campi opzionali
    # Gestisci il caso in cui il JSON potrebbe essere un array di oggetti o un singolo oggetto
    import json
    
    # Leggi il contenuto del JSON
    if hasattr(path_or_buf, 'read'):
        content = path_or_buf.read()
        path_or_buf.seek(0)  # Reset per eventuali letture successive
    else:
        content = path_or_buf
    
    # Parse il JSON
    try:
        data = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        # Se non è una stringa JSON, prova direttamente con pandas
        df = pd.read_json(path_or_buf, orient='records')
    else:
        # Controlla il tipo di dato
        if isinstance(data, list):
            # È un array di oggetti (formato standard Spotify)
            df = pd.DataFrame(data)
        elif isinstance(data, dict):
            # È un dizionario
            # Controlla se tutti i valori sono scalari (non liste/dict)
            if all(not isinstance(v, (list, dict)) for v in data.values()):
                # Tutti valori scalari, crea DataFrame con una riga
                df = pd.DataFrame([data])
            else:
                # Ha valori complessi, prova con orient='index'
                try:
                    df = pd.read_json(content, orient='index')
                except ValueError:
                    # Se fallisce, prova come records
                    df = pd.read_json(content, orient='records')
        else:
            # Tipo non riconosciuto, prova direttamente con pandas
            df = pd.read_json(content, orient='records')
    
    # Aggiungi campi opzionali se non esistono
    if "username" not in df.columns:
        df["username"] = ""
    if "user_agent_decrypted" not in df.columns:
        df["user_agent_decrypted"] = ""
    if "skipped" not in df.columns:
        df["skipped"] = False
    
    # Converti i tipi di dato per i campi esistenti
    dtype_map = {
        "ts": str,
        "endTime": str,  # Nuovo formato
        "username": str,
        "platform": str,
        "ms_played": np.int64,
        "msPlayed": np.int64,  # Nuovo formato
        "conn_country": str,
        "ip_addr_decrypted": str,
        "user_agent_decrypted": str,
        "master_metadata_track_name": str,
        "master_metadata_album_artist_name": str,
        "master_metadata_album_album_name": str,
        "trackName": str,  # Nuovo formato
        "artistName": str,  # Nuovo formato
        "albumName": str,  # Nuovo formato
        "spotify_track_uri": str,
        "episode_name": str,
        "episode_show_name": str,
        "spotify_episode_uri": str,
        "reason_start": str,
        "reason_end": str,
        "shuffle": bool,
        "skipped": bool,
        "offline": bool,
        "offline_timestamp": np.int64,
        "incognito_mode": bool,
    }
    
    # Applica conversioni solo per colonne esistenti
    for col, dtype in dtype_map.items():
        if col in df.columns:
            try:
                if dtype == bool:
                    # Gestisci valori null per boolean
                    df[col] = df[col].fillna(False).astype(bool)
                elif dtype == np.int64:
                    df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0).astype(np.int64)
                else:
                    df[col] = df[col].astype(dtype)
            except (ValueError, TypeError):
                # Se la conversione fallisce, mantieni il tipo originale
                pass
    
    df = df.rename(
        columns={
            "ip_addr_decrypted": "ip_addr",
            "master_metadata_track_name": "track",
            "master_metadata_album_artist_name": "artist",
            "master_metadata_album_album_name": "album",
            # Supporta anche i nuovi formati
            "trackName": "track",
            "artistName": "artist",
            "albumName": "album",
            "endTime": "ts",
            "msPlayed": "ms_played",  # Nuovo formato
        }
    )
    
    # Assicurati che le colonne track, artist, album esistano sempre
    # (potrebbero non esistere se il JSON non le contiene)
    if "track" not in df.columns:
        df["track"] = None
    if "artist" not in df.columns:
        df["artist"] = None
    if "album" not in df.columns:
        df["album"] = None
    
    # Converti tutti i valori complessi (dict, list) in stringhe JSON
    # Questo evita errori quando si chiama drop_duplicates() su colonne con valori non hashable
    if not df.empty:
        for col in df.columns:
            if df[col].dtype == 'object':
                # Converti tutti i valori complessi in stringhe JSON
                def check_and_convert(x):
                    if pd.isna(x):
                        return x
                    if isinstance(x, (dict, list)):
                        try:
                            return json.dumps(x)
                        except (TypeError, ValueError):
                            return str(x)
                    # Se è già una stringa che rappresenta JSON, lasciala così
                    return x
                
                # Applica la conversione a tutti i valori
                df[col] = df[col].apply(check_and_convert)
    
    # Se il DataFrame è vuoto, assicurati che abbia almeno le colonne essenziali
    if df.empty:
        # Crea un DataFrame vuoto con le colonne necessarie
        required_columns = [
            "track", "artist", "album", "ts", "ms_played", "conn_country", 
            "platform", "reason_start", "reason_end", "shuffle", "offline", 
            "offline_timestamp", "incognito_mode", "spotify_track_uri",
            "username", "user_agent_decrypted", "skipped"
        ]
        df = pd.DataFrame(columns=required_columns)
    
    return df


def preprocess_df(df):
    # Verifica che il DataFrame non sia vuoto e abbia le colonne necessarie
    if df.empty:
        # Restituisci un DataFrame vuoto con le colonne necessarie
        return pd.DataFrame(columns=[
            "track", "artist", "album", "year_month_day", "day_name",
            "minutes_played", "reason_start", "reason_end", "conn_country",
            "platform", "shuffle", "full_play", "offline", "incognito_mode",
            "ts", "year", "year_month", "month", "month_index", "ms_played",
            "hours_played", "spotify_track_uri"
        ])
    
    # Verifica che la colonna track esista
    if "track" not in df.columns:
        raise ValueError("Il DataFrame deve contenere la colonna 'track'. Colonne disponibili: " + str(list(df.columns)))
    
    # Verifica che la colonna ts esista (necessaria per il processing)
    if "ts" not in df.columns:
        raise ValueError(f"Colonna 'ts' mancante nel DataFrame. Colonne disponibili: {list(df.columns)}")
    
    df = df[df["track"] != "None"]
    
    # Se dopo il filtro il DataFrame è vuoto, restituisci un DataFrame vuoto con le colonne corrette
    if df.empty:
        return pd.DataFrame(columns=[
            "track", "artist", "album", "year_month_day", "day_name",
            "minutes_played", "reason_start", "reason_end", "conn_country",
            "platform", "shuffle", "full_play", "offline", "incognito_mode",
            "ts", "year", "year_month", "month", "month_index", "ms_played",
            "hours_played", "spotify_track_uri"
        ])
    
    # Converti DIRETTAMENTE tutte le colonne object in stringhe prima di drop_duplicates()
    # Questo è l'unico modo sicuro per evitare errori con valori non hashable (dict, list)
    # Salviamo i tipi originali delle colonne importanti che dobbiamo riconvertire dopo
    important_cols = {
        'ts': 'datetime',
        'ms_played': 'int64',
        'offline_timestamp': 'int64',
        'shuffle': 'bool',
        'skipped': 'bool',
        'offline': 'bool',
        'incognito_mode': 'bool'
    }
    
    # Converti tutte le colonne object in stringhe
    for col in df.columns:
        if df[col].dtype == 'object':
            df[col] = df[col].astype(str)
    
    # Ora possiamo rimuovere i duplicati in sicurezza
    df = df.drop_duplicates()
    
    # Verifica che dopo drop_duplicates le colonne essenziali esistano ancora
    if df.empty:
        return pd.DataFrame(columns=[
            "track", "artist", "album", "year_month_day", "day_name",
            "minutes_played", "reason_start", "reason_end", "conn_country",
            "platform", "shuffle", "full_play", "offline", "incognito_mode",
            "ts", "year", "year_month", "month", "month_index", "ms_played",
            "hours_played", "spotify_track_uri"
        ])
    
    if "ts" not in df.columns:
        raise ValueError(f"Colonna 'ts' persa dopo drop_duplicates(). Colonne disponibili: {list(df.columns)}")
    
    # Riconverti le colonne importanti ai loro tipi originali (se esistono)
    # Nota: ts verrà riconvertito più avanti con pd.to_datetime
    for col, dtype in important_cols.items():
        if col in df.columns:
            if dtype == 'int64':
                df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0).astype('int64')
            elif dtype == 'bool':
                # Per i boolean, converti da stringa a boolean
                # Gestisci i casi comuni: 'True', 'False', 'true', 'false', 'nan', 'None', etc.
                def str_to_bool(x):
                    if pd.isna(x) or x in ['nan', 'None', '']:
                        return False
                    if isinstance(x, str):
                        x_lower = x.lower()
                        if x_lower in ['true', '1', 'yes']:
                            return True
                        elif x_lower in ['false', '0', 'no']:
                            return False
                    return bool(x)
                df[col] = df[col].apply(str_to_bool).astype(bool)

    # Verifica che le colonne necessarie esistano prima di processarle
    if "ts" not in df.columns:
        raise ValueError(f"Colonna 'ts' mancante nel DataFrame. Colonne disponibili: {list(df.columns)}")
    
    if df.empty:
        return df
    
    df["ts"] = pd.to_datetime(df["ts"], format="%Y-%m-%dT%H:%M:%SZ", errors='coerce')
    
    # Gestisci offline_timestamp solo se esiste
    if "offline_timestamp" in df.columns:
        df.loc[df["offline_timestamp"] > 2000000000, "offline_timestamp"] /= 1000
        mask = df["offline_timestamp"] > 100
        df["offline_timestamp"] = pd.to_datetime(df["offline_timestamp"], unit="s", errors='coerce')
        df["ts"].values[mask] = df.loc[mask, "offline_timestamp"]

    df["year_month"] = df["ts"].dt.to_period("M")
    df["year"] = df["ts"].dt.year
    df["month"] = df["ts"].dt.month

    earliest_month = df["year_month"].min()
    df["month_index"] = (df["year_month"] - earliest_month).apply(lambda x: x.n)
    df["year_month"] = df["year_month"].dt.strftime("%Y-%m")

    df["year_month_day"] = df["ts"].dt.strftime("%Y-%m-%d")
    df["day_name"] = df["ts"].dt.day_name().astype(str)

    df["minutes_played"] = df["ms_played"] / 1000 / 60
    df["hours_played"] = df["ms_played"] / 1000 / 60 / 60

    df["reason_start"].replace(
        {"backbtn": "back button", "fwdbtn": "forward button", "playbtn": "play button"}, inplace=True
    )
    df["reason_end"].replace(
        {"backbtn": "back button", "endplay": "end play", "fwdbtn": "forward button"}, inplace=True
    )

    df["full_play"] = df["reason_end"] == "trackdone"

    df["track"] = df["track"] + "~~sep~~" + df["artist"]
    df["album"] = df["album"] + "~~sep~~" + df["artist"]

    df.sort_values(by="ts", ascending=True, inplace=True)

    df = df.drop(
        columns=[
            "ip_addr",
            "episode_name",
            "episode_show_name",
            "spotify_episode_uri",
            "offline_timestamp",
        ]
    )
    
    # Costruisci la lista delle colonne da mantenere, controllando se esistono
    columns_to_keep = [
        "track",
        "artist",
        "album",
        "year_month_day",
        "day_name",
        "minutes_played",
        "reason_start",
        "reason_end",
        "conn_country",
        "platform",
        "shuffle",
        "full_play",
        "offline",
        "incognito_mode",
        "ts",
        "year",
        "year_month",
        "month",
        "month_index",
        "ms_played",
        "hours_played",
        "spotify_track_uri",
    ]
    
    # Aggiungi colonne opzionali solo se esistono
    optional_columns = ["skipped", "username", "user_agent_decrypted"]
    for col in optional_columns:
        if col in df.columns:
            columns_to_keep.append(col)
    
    # Seleziona solo le colonne che esistono
    columns_to_keep = [col for col in columns_to_keep if col in df.columns]
    df = df[columns_to_keep]
    return df


def df_dict_to_df_json_dict(df_dict):
    for name, df in df_dict.items():
        df = df.round(2)
        df_dict[name] = df.to_dict(orient="split")
        del df_dict[name]["index"]


def replace_track_artist(df):
    column_index = df.columns.get_loc("track")
    split_track_artist = df["track"].str.split("~~sep~~", n=1, expand=True)
    df["track"] = split_track_artist[0]
    if "artist" not in df:
        df.insert(column_index + 1, "artist", split_track_artist[1])


def replace_album_artist(df):
    column_index = df.columns.get_loc("album")
    split_track_artist = df["album"].str.split("~~sep~~", n=1, expand=True)
    df["album"] = split_track_artist[0]
    if "artist" not in df:
        df.insert(column_index + 1, "artist", split_track_artist[1])


country_code_to_name = {
    "AF": "Afghanistan", "AX": "Åland Islands", "AL": "Albania", "DZ": "Algeria", "AS": "American Samoa",
    "AD": "Andorra", "AO": "Angola", "AI": "Anguilla", "AQ": "Antarctica", "AG": "Antigua and Barbuda",
    "AR": "Argentina", "AM": "Armenia", "AW": "Aruba", "AU": "Australia", "AT": "Austria",
    "AZ": "Azerbaijan", "BS": "Bahamas", "BH": "Bahrain", "BD": "Bangladesh", "BB": "Barbados",
    "BY": "Belarus", "BE": "Belgium", "BZ": "Belize", "BJ": "Benin", "BM": "Bermuda",
    "BT": "Bhutan", "BO": "Bolivia, Plurinational State of", "BQ": "Bonaire, Sint Eustatius and Saba",
    "BA": "Bosnia and Herzegovina", "BW": "Botswana", "BV": "Bouvet Island", "BR": "Brazil",
    "IO": "British Indian Ocean Territory", "BN": "Brunei Darussalam", "BG": "Bulgaria",
    "BF": "Burkina Faso", "BI": "Burundi", "KH": "Cambodia", "CM": "Cameroon", "CA": "Canada",
    "CV": "Cape Verde", "KY": "Cayman Islands", "CF": "Central African Republic", "TD": "Chad",
    "CL": "Chile", "CN": "China", "CX": "Christmas Island", "CC": "Cocos (Keeling) Islands",
    "CO": "Colombia", "KM": "Comoros", "CG": "Congo", "CD": "Congo, the Democratic Republic of the",
    "CK": "Cook Islands", "CR": "Costa Rica", "CI": "Côte d'Ivoire", "HR": "Croatia", "CU": "Cuba",
    "CW": "Curaçao", "CY": "Cyprus", "CZ": "Czech Republic", "DK": "Denmark", "DJ": "Djibouti",
    "DM": "Dominica", "DO": "Dominican Republic", "EC": "Ecuador", "EG": "Egypt", "SV": "El Salvador",
    "GQ": "Equatorial Guinea", "ER": "Eritrea", "EE": "Estonia", "ET": "Ethiopia",
    "FK": "Falkland Islands (Malvinas)", "FO": "Faroe Islands", "FJ": "Fiji", "FI": "Finland",
    "FR": "France", "GF": "French Guiana", "PF": "French Polynesia", "TF": "French Southern Territories",
    "GA": "Gabon", "GM": "Gambia", "GE": "Georgia", "DE": "Germany", "GH": "Ghana",
    "GI": "Gibraltar", "GR": "Greece", "GL": "Greenland", "GD": "Grenada", "GP": "Guadeloupe",
    "GU": "Guam", "GT": "Guatemala", "GG": "Guernsey", "GN": "Guinea", "GW": "Guinea-Bissau",
    "GY": "Guyana", "HT": "Haiti", "HM": "Heard Island and McDonald Islands",
    "VA": "Holy See (Vatican City State)", "HN": "Honduras", "HK": "Hong Kong", "HU": "Hungary",
    "IS": "Iceland", "IN": "India", "ID": "Indonesia", "IR": "Iran, Islamic Republic of", "IQ": "Iraq",
    "IE": "Ireland", "IM": "Isle of Man", "IL": "Israel", "IT": "Italy", "JM": "Jamaica",
    "JP": "Japan", "JE": "Jersey", "JO": "Jordan", "KZ": "Kazakhstan", "KE": "Kenya", "KI": "Kiribati",
    "KP": "Korea, Democratic People's Republic of", "KR": "Korea, Republic of", "KW": "Kuwait",
    "KG": "Kyrgyzstan", "LA": "Lao People's Democratic Republic", "LV": "Latvia", "LB": "Lebanon",
    "LS": "Lesotho", "LR": "Liberia", "LY": "Libya", "LI": "Liechtenstein", "LT": "Lithuania",
    "LU": "Luxembourg", "MO": "Macao", "MK": "Macedonia, the Former Yugoslav Republic of",
    "MG": "Madagascar", "MW": "Malawi", "MY": "Malaysia", "MV": "Maldives", "ML": "Mali",
    "MT": "Malta", "MH": "Marshall Islands", "MQ": "Martinique", "MR": "Mauritania", "MU": "Mauritius",
    "YT": "Mayotte", "MX": "Mexico", "FM": "Micronesia, Federated States of", "MD": "Moldova, Republic of",
    "MC": "Monaco", "MN": "Mongolia", "ME": "Montenegro", "MS": "Montserrat", "MA": "Morocco",
    "MZ": "Mozambique", "MM": "Myanmar", "NA": "Namibia", "NR": "Nauru", "NP": "Nepal",
    "NL": "Netherlands", "NC": "New Caledonia", "NZ": "New Zealand", "NI": "Nicaragua", "NE": "Niger",
    "NG": "Nigeria", "NU": "Niue", "NF": "Norfolk Island", "MP": "Northern Mariana Islands",
    "NO": "Norway", "OM": "Oman", "PK": "Pakistan", "PW": "Palau", "PS": "Palestine, State of",
    "PA": "Panama", "PG": "Papua New Guinea", "PY": "Paraguay", "PE": "Peru", "PH": "Philippines",
    "PN": "Pitcairn", "PL": "Poland", "PT": "Portugal", "PR": "Puerto Rico", "QA": "Qatar",
    "RE": "Réunion", "RO": "Romania", "RU": "Russian Federation", "RW": "Rwanda",
    "BL": "Saint Barthélemy", "SH": "Saint Helena, Ascension and Tristan da Cunha",
    "KN": "Saint Kitts and Nevis", "LC": "Saint Lucia", "MF": "Saint Martin (French part)",
    "PM": "Saint Pierre and Miquelon", "VC": "Saint Vincent and the Grenadines", "WS": "Samoa",
    "SM": "San Marino", "ST": "Sao Tome and Principe", "SA": "Saudi Arabia", "SN": "Senegal",
    "RS": "Serbia", "SC": "Seychelles", "SL": "Sierra Leone", "SG": "Singapore",
    "SX": "Sint Maarten (Dutch part)", "SK": "Slovakia", "SI": "Slovenia", "SB": "Solomon Islands",
    "SO": "Somalia", "ZA": "South Africa", "GS": "South Georgia and the South Sandwich Islands",
    "SS": "South Sudan", "ES": "Spain", "LK": "Sri Lanka", "SD": "Sudan", "SR": "Suriname",
    "SJ": "Svalbard and Jan Mayen", "SZ": "Swaziland", "SE": "Sweden", "CH": "Switzerland",
    "SY": "Syrian Arab Republic", "TW": "Taiwan, Province of China", "TJ": "Tajikistan",
    "TZ": "Tanzania, United Republic of", "TH": "Thailand", "TL": "Timor-Leste", "TG": "Togo",
    "TK": "Tokelau", "TO": "Tonga", "TT": "Trinidad and Tobago", "TN": "Tunisia", "TR": "Turkey",
    "TM": "Turkmenistan", "TC": "Turks and Caicos Islands", "TV": "Tuvalu", "UG": "Uganda",
    "UA": "Ukraine", "AE": "United Arab Emirates", "GB": "United Kingdom", "US": "United States",
    "UM": "United States Minor Outlying Islands", "UY": "Uruguay", "UZ": "Uzbekistan", "VU": "Vanuatu",
    "VE": "Venezuela, Bolivarian Republic of", "VN": "Viet Nam", "VG": "Virgin Islands, British",
    "VI": "Virgin Islands, U.S.", "WF": "Wallis and Futuna", "EH": "Western Sahara", "YE": "Yemen",
    "ZM": "Zambia", "ZW": "Zimbabwe",
}


def country_code_to_country_name(df):
    df["conn_country"] = df["conn_country"].apply(
        lambda x: country_code_to_name[x] if x in country_code_to_name else "unknown"
    )


def post_process_dataframe_dict(df_dict):
    for _, df in df_dict.items():
        if "track" in df:
            replace_track_artist(df)
        if "album" in df:
            replace_album_artist(df)
        if "hours_played" in df:
            df.rename(columns={"hours_played": "hours played"}, inplace=True)
        if "conn_country" in df:
            country_code_to_name(df)
        if "year_month" in df:
            df.rename(columns={"year_month": "month"}, inplace=True)


def numpy_to_base64_bmp(array):
    array = np.flipud(array)
    padding = b"\x00" * ((4 - (array.shape[1] % 4)) % 4)
    output = BytesIO()

    output.write(b"BM")
    output.write((array.size + len(padding) * array.shape[0] + 1078).to_bytes(4, "little"))
    output.write((0).to_bytes(4, "little"))
    output.write((1078).to_bytes(4, "little"))

    output.write((40).to_bytes(4, "little"))
    output.write((array.shape[1]).to_bytes(4, "little"))
    output.write((array.shape[0]).to_bytes(4, "little"))
    output.write((1).to_bytes(2, "little"))
    output.write((8).to_bytes(2, "little"))
    output.write((0).to_bytes(4, "little"))
    output.write((array.size + len(padding) * array.shape[0]).to_bytes(4, "little"))
    output.write((0).to_bytes(4, "little"))
    output.write((0).to_bytes(4, "little"))
    output.write((256).to_bytes(4, "little"))
    output.write((0).to_bytes(4, "little"))

    for i in range(256):
        output.write(bytes([i, i, i, 0]))

    for row in array:
        output.write(row.tobytes())
        output.write(padding)

    byte_data = output.getvalue()
    base64_str = base64.b64encode(byte_data).decode("utf-8")
    return base64_str


def get_monthly_play_images(df, column_name):
    image_width = df["month_index"].max() + 1
    grouped = df.groupby([column_name, "month_index"]).size().rename("count").reset_index()
    name_groups = grouped.groupby(column_name)

    all_values = grouped["count"].values
    y_value_multiplier = 40 / np.percentile(all_values, 99)

    names = []
    images = []
    for name, group in name_groups:
        names.append(name)
        image = np.ones((image_width, 40), dtype=np.uint8) * 210
        for index, value in zip(group["month_index"], group["count"]):
            image[index, 40 - min(int(np.round(value * y_value_multiplier)), 40) :] = 0
        images.append(f"data:image/bmp;base64,{numpy_to_base64_bmp(image.T)}")

    df = pd.DataFrame({column_name: names, f"monthly play count<br>(up to {int(40/y_value_multiplier)} plays)": images})
    return df


def get_most_played_artists_tracks_albums_total(
    df, top_k, suffix="", column_name_muliplier_list=("artist", "track", "album")
):
    df_dict = {}
    for column_name in column_name_muliplier_list:
        df_top = df.groupby([column_name]).agg({"full_play": "sum", "hours_played": "sum"})
        df_top.rename(columns={"full_play": "play count"}, inplace=True)
        df_top = df_top.reset_index().nlargest(top_k, "play count")

        if column_name == "artist":
            artist_track_count = df.groupby("artist")["track"].nunique().to_dict()
            df_top["# of unique tracks played"] = df_top["artist"].map(artist_track_count)

        df_image = get_monthly_play_images(
            df[(df[column_name].isin(df_top[column_name])) & df["full_play"]], column_name
        )
        df_top = pd.merge(df_top, df_image, on=column_name)
        df_dict[f"most_played_{column_name}s_total{suffix}"] = df_top
    return df_dict


def get_top_songs_of_top_artists(df, top_k):
    top_artists_data = df.groupby("artist").agg({"full_play": "sum"}).nlargest(top_k, "full_play")

    artists = []
    top_1_songs = []
    top_2_songs = []
    top_3_songs = []
    for artist, play_count in top_artists_data.iterrows():
        artist_data = df[df["artist"] == artist]
        top_tracks = artist_data.groupby("track").agg({"full_play": "sum"}).nlargest(3, "full_play")

        artists.append(f"{artist} ({play_count['full_play']} plays)")
        top_1_songs.append(f"{top_tracks.index[0].split('~~sep~~')[0]} ({top_tracks.iloc[0, 0]} plays)")

        if len(top_tracks) > 1:
            top_2_songs.append(f"{top_tracks.index[1].split('~~sep~~')[0]} ({top_tracks.iloc[1, 0]} plays)")
        else:
            top_2_songs.append(None)

        if len(top_tracks) > 2:
            top_3_songs.append(f"{top_tracks.index[2].split('~~sep~~')[0]} ({top_tracks.iloc[2, 0]} plays)")
        else:
            top_3_songs.append(None)

    result_df = pd.DataFrame(
        {"artist": artists, "top-1 song": top_1_songs, "top-2 song": top_2_songs, "top-3 song": top_3_songs}
    )
    return {"top_songs_of_top_artists": result_df}


def get_most_played_artist_track_album_monthly(df):
    combined_df = df[["year_month"]].drop_duplicates().sort_values(by="year_month").reset_index(drop=True)
    for column_name in ["artist", "track", "album"]:
        df_top = (
            df.groupby(["year_month", column_name])
            .size()
            .reset_index(name="play count")
            .loc[lambda x: x.groupby("year_month")["play count"].idxmax()]
        )

        if column_name in ["track", "album"]:
            df_top[column_name] = df_top[column_name].str.replace("~~sep~~", " (by ")
            seperator = ", "
        else:
            seperator = " ("
        df_top[f"most played {column_name}"] = (
            df_top[column_name] + seperator + df_top["play count"].astype(str) + " times)"
        )

        combined_df = pd.merge(
            combined_df, df_top[["year_month", f"most played {column_name}"]], on="year_month", how="left"
        )

    combined_df = combined_df.sort_values(by="year_month", ascending=False).reset_index(drop=True)
    return {"most_played_artists_track_album_monthly": combined_df}


def get_avg_track_length_monthly(df):
    df = (
        df[df["full_play"]]
        .groupby("year_month")["minutes_played"]
        .agg(lambda series: series.sum() / series.size)
        .reset_index()
        .rename(columns={"minutes_played": "minutes played"})
    )
    return {"avg_track_length_monthly": df}


def get_avg_play_count_per_song_yearly(df):
    play_counts = df[df["full_play"]].groupby(["year", "track"]).size().reset_index(name="play count")
    avg_play_counts = play_counts.groupby("year")["play count"].mean().reset_index()
    return {"avg_play_count_per_song_yearly": avg_play_counts}


def get_play_count_distribution(df):
    play_counts = df[df["full_play"]].groupby(["track"]).size().reset_index(name="play count")
    distribution = play_counts.groupby("play count").size().reset_index(name="num of songs")
    distribution = distribution.sort_values(by="play count", ascending=False)
    return {"play_count_distribution": distribution}


def get_yeary_track_artist_play_count(df):
    out = {}
    play_counts = df[df["full_play"]].groupby(["year"])["track"].size().reset_index(name="total")
    unique = df[df["full_play"]].groupby("year")["track"].nunique().reset_index(name="unique per year")

    df_sorted = df[df["full_play"]].sort_values("year")
    seen_tracks = set()

    def mark_new_tracks(row):
        if row["track"] in seen_tracks:
            return False
        else:
            seen_tracks.add(row["track"])
            return True

    df_sorted["is_new"] = df_sorted.apply(mark_new_tracks, axis=1)
    new_tracks = df_sorted[df_sorted["is_new"]].groupby("year").size().reset_index(name="new")

    result = pd.merge(play_counts, unique, on="year", how="left")
    result = pd.merge(result, new_tracks, on="year", how="left").fillna(0)
    out["yearly_track_play_count"] = result
    return out


def get_hours_played_per_hour_of_the_day(df):
    df["hour"] = df["ts"].dt.hour
    hours_per_period = df.groupby(["hour"])["hours_played"].sum().reset_index()

    hours_per_period["hours_played"] = np.round(
        hours_per_period["hours_played"] / hours_per_period["hours_played"].sum() * 100, 2
    )
    hours_per_period = hours_per_period.rename(
        columns={"hour": "hour of the day", "hours_played": "percent of play time"}
    )

    return {"hours_played_percent_per_hour_of_the_day": hours_per_period}


def get_avg_hours_played_per_year_month_weekday(df):
    df_dict = {}
    first_day = pd.Timestamp(df["year_month_day"].min())
    last_day = pd.Timestamp(df["year_month_day"].max())

    for time_period in ["year_month", "year", "month", "day_name"]:
        hours_per_period = df.groupby([time_period])["hours_played"].sum()

        if time_period == "year_month":
            days_per_period = pd.date_range(start=first_day, end=last_day).to_period("M").value_counts().sort_index()
            days_per_period.index = days_per_period.index.strftime("%Y-%m")

        elif time_period == "year":
            days_per_period = pd.Series(index=hours_per_period.index, data=365)
            days_per_period[first_day.year] = (pd.Timestamp(f"{first_day.year}-12-31") - first_day).days + 1
            days_per_period[last_day.year] = (last_day - pd.Timestamp(f"{last_day.year}-01-01")).days + 1

        elif time_period == "month":
            month_names = [pd.Timestamp(2023, x, 1).month_name() for x in range(1, 13)]
            hours_per_period.index = pd.Series(hours_per_period.index).apply(lambda x: month_names[x - 1])
            hours_per_period.index = pd.CategoricalIndex(hours_per_period.index, categories=month_names, ordered=True)
            hours_per_period.sort_index(inplace=True)

            df_data_range = pd.DataFrame(pd.date_range(first_day, last_day), columns=["date"])
            df_data_range["month"] = df_data_range["date"].dt.month_name()
            days_per_period = df_data_range.groupby(["month"]).size()
            days_per_period.index = pd.CategoricalIndex(days_per_period.index, categories=month_names, ordered=True)
            days_per_period.sort_index(inplace=True)

        elif time_period == "day_name":
            days_per_period = pd.date_range(start=first_day, end=last_day).day_name().value_counts().sort_index()
            weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
            hours_per_period.index = pd.Categorical(hours_per_period.index, categories=weekdays, ordered=True)
            hours_per_period = hours_per_period.sort_index()
            days_per_period.index = pd.Categorical(days_per_period.index, categories=weekdays, ordered=True)
            days_per_period = days_per_period.sort_index()

        avg_hours_per_period = hours_per_period / days_per_period

        avg_hours_per_period = (
            avg_hours_per_period.rename("avg hours played per day")
            .reset_index()
            .rename(columns={"index": time_period.replace("_", " ")})
        )

        df_dict[f"avg_hours_played_per_{time_period}"] = avg_hours_per_period
    return df_dict


def get_plays_per_county_toal(df):
    df = (
        df[df["full_play"]]
        .groupby("conn_country")
        .size()
        .rename("full_playes")
        .sort_values(ascending=False)
        .reset_index()
        .rename(columns={"conn_country": "country", "full_playes": "play count"})
    )
    return {"plays_per_county_total": df}


def get_cumulative_percent_play_count_track_artists(df):
    out = {}
    for unit in ("track", "artist"):
        count_per_unit = (
            df[df["full_play"]]
            .groupby(unit)
            .size()
            .reset_index(name="played count")
            .sort_values(by="played count", ascending=False)
        )
        count_per_unit[f"number of {unit}s"] = range(1, len(count_per_unit) + 1)

        total_played_songs = len(df[df["full_play"]])
        count_per_unit["percent of played songs"] = (count_per_unit["played count"].cumsum() / total_played_songs) * 100

        count_per_unit = count_per_unit.drop(columns=[unit, "played count"])

        count_per_unit = pd.concat(
            [pd.DataFrame({f"number of {unit}s": [0], "percent of played songs": [0]}), count_per_unit]
        )
        out[f"cumulative_percent_play_count_{unit}"] = count_per_unit

    return out


def hours_to_str(hours):
    if hours >= 10:
        return f"{round(hours)}h"
    else:
        return f"{int(hours)}:{str(round((hours % 1) * 60)).zfill(2)}h"


def get_single_values(df, df_dict):
    data = {}
    data["first_day"] = df["year_month_day"].min()
    data["last_day"] = df["year_month_day"].max()
    first_day_ts = pd.Timestamp(data["first_day"])
    last_day_ts = pd.Timestamp(data["last_day"])
    data["number_of_days"] = (last_day_ts - first_day_ts).days
    data["number_of_days_with_tracks_played"] = df[df["full_play"]]["year_month_day"].nunique()
    data["percent_of_days_with_tracks_played"] = round(
        data["number_of_days_with_tracks_played"] / data["number_of_days"] * 100
    )

    df_full_play = df[df["full_play"]]

    played_songs = len(df_full_play)
    data["played_songs"] = played_songs
    data["played_songs_per_day"] = round(played_songs / data["number_of_days"])

    data["unique_tracks_played"] = df_full_play["track"].nunique()
    data["unique_artists_played"] = df_full_play["artist"].nunique()
    data["unique_albums_played"] = df_full_play["album"].nunique()
    data["unique_tracks_played_per_artist"] = round(data["unique_tracks_played"] / data["unique_artists_played"], 1)

    data["listening_hours"] = round(df["hours_played"].sum())
    data["listening_hours_per_day"] = hours_to_str(data["listening_hours"] / data["number_of_days"])[:-1]

    played_shuffle_count = len(df_full_play[df_full_play["shuffle"]])
    data["percent_of_played_songs_using_shuffle"] = round(played_shuffle_count / played_songs * 100)

    started_songs_shuffle = len(df[df["shuffle"]])
    skipped_df = df[df["reason_end"] == "forward button"]
    skipped_songs = len(skipped_df)
    data["skipped_songs"] = skipped_songs
    data["percent_of_skipped_songs"] = round(skipped_songs / (len(df)) * 100)

    if skipped_songs == 0:
        data["avg_seconds_played_before_skipping"] = 0
        data["percent_of_songs_skipped_before_3s"] = 0
        data["percent_of_songs_skipped_after_30s"] = 0
        data["percent_of_songs_skipped_after_120s"] = 0
    else:
        data["avg_seconds_played_before_skipping"] = round(skipped_df["minutes_played"].mean() * 60)
        data["percent_of_songs_skipped_before_3s"] = round(
            len(skipped_df[skipped_df["minutes_played"] < 3 / 60]) / skipped_songs * 100
        )
        data["percent_of_songs_skipped_after_30s"] = round(
            len(skipped_df[skipped_df["minutes_played"] > 30 / 60]) / skipped_songs * 100
        )
        data["percent_of_songs_skipped_after_120s"] = round(
            len(skipped_df[skipped_df["minutes_played"] > 2]) / skipped_songs * 100
        )

    shuffle_and_skipped = len(df[(df["reason_end"] == "forward button") & df["shuffle"]])
    not_shuffle_and_skipped = len(df[(df["reason_end"] == "forward button") & ~df["shuffle"]])

    if started_songs_shuffle == 0:
        data["percent_of_skipped_songs_using_shuffle"] = 0
        data["percent_of_skipped_songs_not_using_shuffle"] = 0
    else:
        data["percent_of_skipped_songs_using_shuffle"] = round(shuffle_and_skipped / started_songs_shuffle * 100)
        data["percent_of_skipped_songs_not_using_shuffle"] = round(
            not_shuffle_and_skipped / started_songs_shuffle * 100
        )

    data["percent_reason_start_forward_button"] = round(len(df[df["reason_start"] == "forward button"]) / len(df) * 100)
    data["percent_reason_start_back_button"] = round(len(df[df["reason_start"] == "back button"]) / len(df) * 100)
    data["percent_reason_start_trackdone"] = round(len(df[df["reason_start"] == "trackdone"]) / len(df) * 100)
    data["percent_reason_start_clickrow"] = round(len(df[df["reason_start"] == "clickrow"]) / len(df) * 100)

    data["percent_of_played_songs_using_incognito_mode"] = round(
        df_full_play["incognito_mode"].sum() / played_songs * 100
    )

    data["average_play_count_per_song"] = round(df_full_play.groupby(["track"]).size().mean(), 1)

    data["percent_played_songs_reason_start_clickrow"] = round(
        len(df_full_play[df_full_play["reason_start"] == "clickrow"]) / played_songs * 100
    )

    for unit in ("artist", "track"):
        for top_n in (10, 100, 500):
            data[f"top_{top_n}_{unit}_play_count_percent"] = round(
                df_dict[f"cumulative_percent_play_count_{unit}"]["percent of played songs"].iloc[
                    min(top_n, data[f"unique_{unit}s_played"] - 1)
                ]
            )

    artists = df_dict["most_played_artists_total"]["artist"]
    tracks = df_dict["most_played_tracks_total"]["track"]
    for i in range(3):
        data[f"top_{i+1}_artist"] = artists.iloc[i] if len(artists) > i else "-"
        data[f"top_{i+1}_track"] = tracks.iloc[i] if len(tracks) > i else "-"

    return data


def get_df_random_sample(df, sample_count=1):
    df_sample = df.sample(sample_count)
    replace_track_artist(df_sample)
    replace_album_artist(df_sample)
    df_dict = df_sample.to_dict(orient="split")
    df_dict["data"].insert(0, df_dict["columns"])
    transposed_data = list(map(list, zip(*df_dict["data"])))
    df_dict = {"columns": ["columns", *[f"sample {i}" for i in range(1, sample_count + 1)]], "data": transposed_data}
    return df_dict




def classify_mood(valence, energy=None, threshold=0.5, neutral_range=0.05):
    """
    Classificatore del mood basato sul modello a quadranti.
    Utilizza Valence (X) ed Energy (Y) per classificare le canzoni in 5 categorie principali.

    Quadranti:
    - Q1: Alta Valence (> threshold) + Alta Energy (> threshold) → "euforico"
    - Q2: Alta Valence (> threshold) + Bassa Energy (<= threshold) → "sereno"
    - Q3: Bassa Valence (<= threshold) + Alta Energy (> threshold) → "arrabbiato"
    - Q4: Bassa Valence (<= threshold) + Bassa Energy (<= threshold) → "malinconico"

    I valori molto vicini alla soglia (es. tra threshold - neutral_range e threshold + neutral_range)
    vengono classificati come "neutrale" per evitare errori di classificazione.

    Args:
        valence: Valore di valenza da 0.0 a 1.0 (0.0 = triste, 1.0 = felice)
        energy: Valore di energia da 0.0 a 1.0 (0.0 = calma, 1.0 = intensa). Opzionale.
        threshold: Soglia di divisione (default: 0.5)
        neutral_range: Range per considerare un valore "neutrale" (default: 0.05, quindi 0.45-0.55)

    Returns:
        Categoria del mood: "euforico", "sereno", "arrabbiato", "malinconico", "neutrale", "sconosciuto"
    """
    # Valida i parametri
    if pd.isna(valence) or valence is None:
        return "sconosciuto"
    
    # Normalizza valence tra 0 e 1
    normalized_valence = max(0.0, min(1.0, float(valence)))
    
    # Se energy non è disponibile, usa solo valence (fallback)
    if pd.isna(energy) or energy is None:
        if normalized_valence >= threshold + neutral_range:
            return "euforico"  # Approssimazione: alta valence senza energy → sereno/euforico
        elif normalized_valence <= threshold - neutral_range:
            return "malinconico"  # Bassa valence senza energy → malinconico
        else:
            return "neutrale"
    
    # Normalizza energy tra 0 e 1
    normalized_energy = max(0.0, min(1.0, float(energy)))
    
    # Calcola i range neutri
    valence_lower_bound = threshold - neutral_range
    valence_upper_bound = threshold + neutral_range
    energy_lower_bound = threshold - neutral_range
    energy_upper_bound = threshold + neutral_range
    
    # Gestione dei casi "neutri" - quando i valori sono molto vicini alla soglia
    # IMPORTANTE: "neutrale" solo se ENTRAMBI i valori sono nella zona neutra
    # Se solo uno è neutro, procedi con la classificazione a quadranti normale
    is_valence_neutral = valence_lower_bound <= normalized_valence <= valence_upper_bound
    is_energy_neutral = energy_lower_bound <= normalized_energy <= energy_upper_bound
    
    # Se entrambi i valori sono nella zona neutra, classifica come neutrale
    # Questa è la PRIMA verifica da fare (priorità massima)
    if is_valence_neutral and is_energy_neutral:
        return "neutrale"
    
    # Classificazione a quadranti
    # Quadrante 1: Alta Valence (> threshold) + Alta Energy (> threshold)
    # Mood: Euforico
    if normalized_valence > threshold and normalized_energy > threshold:
        return "euforico"
    
    # Quadrante 2: Alta Valence (> threshold) + Bassa Energy (<= threshold)
    # Mood: Sereno
    if normalized_valence > threshold and normalized_energy <= threshold:
        return "sereno"
    
    # Quadrante 3: Bassa Valence (<= threshold) + Alta Energy (> threshold)
    # Mood: Arrabbiato
    if normalized_valence <= threshold and normalized_energy > threshold:
        return "arrabbiato"
    
    # Quadrante 4: Bassa Valence (<= threshold) + Bassa Energy (<= threshold)
    # Mood: Malinconico
    if normalized_valence <= threshold and normalized_energy <= threshold:
        return "malinconico"
    
    # Fallback (non dovrebbe mai arrivare qui)
    return "neutrale"


def parse_user_agent(user_agent):
    """
    Estrae informazioni dal user agent string.
    Restituisce dispositivo/browser semplificato.
    """
    if pd.isna(user_agent) or user_agent == "":
        return "unknown"
    
    ua_lower = str(user_agent).lower()
    
    # Dispositivi mobili
    if "android" in ua_lower:
        if "mobile" in ua_lower or "phone" in ua_lower:
            return "Android Mobile"
        return "Android Tablet"
    elif "iphone" in ua_lower or "ipod" in ua_lower:
        return "iPhone/iPod"
    elif "ipad" in ua_lower:
        return "iPad"
    
    # Browser desktop
    elif "chrome" in ua_lower and "edg" not in ua_lower:
        return "Chrome"
    elif "firefox" in ua_lower:
        return "Firefox"
    elif "safari" in ua_lower and "chrome" not in ua_lower:
        return "Safari"
    elif "edg" in ua_lower or "edge" in ua_lower:
        return "Edge"
    elif "opera" in ua_lower:
        return "Opera"
    
    # Piattaforme specifiche
    elif "spotify" in ua_lower:
        if "windows" in ua_lower:
            return "Spotify Desktop (Windows)"
        elif "mac" in ua_lower or "darwin" in ua_lower:
            return "Spotify Desktop (Mac)"
        elif "linux" in ua_lower:
            return "Spotify Desktop (Linux)"
        return "Spotify Desktop"
    elif "web player" in ua_lower:
        return "Spotify Web Player"
    
    return "Other"


def get_user_agent_statistics(df):
    """
    Analizza le statistiche per user agent (dispositivo/browser).
    """
    out = {}
    
    if "user_agent_decrypted" not in df.columns:
        return out
    
    # Estrai dispositivo/browser
    df_copy = df.copy()
    # Gestisci valori null/None/NaN
    df_copy["user_agent_decrypted"] = df_copy["user_agent_decrypted"].fillna("")
    df_copy["device_browser"] = df_copy["user_agent_decrypted"].apply(parse_user_agent)
    
    # Statistiche per dispositivo/browser
    device_stats = (
        df_copy[df_copy["full_play"]]
        .groupby("device_browser")
        .agg({
            "full_play": "count",
            "hours_played": "sum"
        })
        .rename(columns={"full_play": "play count"})
        .sort_values("play count", ascending=False)
        .reset_index()
    )
    device_stats["hours played"] = device_stats["hours_played"].round(2)
    device_stats = device_stats.drop(columns=["hours_played"])
    out["device_browser_stats"] = device_stats
    
    # Percentuale per dispositivo/browser
    total_plays = len(df_copy[df_copy["full_play"]])
    device_stats["percent"] = round(device_stats["play count"] / total_plays * 100, 2)
    out["device_browser_percent"] = device_stats[["device_browser", "percent"]]
    
    # Dispositivo/browser per mese
    device_monthly = (
        df_copy[df_copy["full_play"]]
        .groupby(["year_month", "device_browser"])
        .size()
        .reset_index(name="play count")
    )
    device_monthly_pivot = device_monthly.pivot(
        index="year_month", 
        columns="device_browser", 
        values="play count"
    ).fillna(0)
    device_monthly_pivot = device_monthly_pivot.reset_index()
    out["device_browser_monthly"] = device_monthly_pivot
    
    return out


def get_skipped_statistics(df):
    """
    Analisi dettagliate sui brani saltati usando il campo skipped.
    """
    out = {}
    
    if "skipped" not in df.columns:
        return out
    
    # Converti skipped in boolean se necessario
    df_copy = df.copy()
    # Gestisci valori null/None/NaN
    df_copy["skipped"] = df_copy["skipped"].fillna(False)
    if df_copy["skipped"].dtype == "object":
        # Converti stringhe "True"/"False" e altri valori
        df_copy["skipped"] = df_copy["skipped"].apply(
            lambda x: True if str(x).lower() in ["true", "1", "yes"] else False
        )
    df_copy["skipped"] = df_copy["skipped"].astype(bool)
    
    # Statistiche generali sui brani saltati
    total_songs = len(df_copy)
    skipped_songs = df_copy["skipped"].sum()
    not_skipped_songs = total_songs - skipped_songs
    
    skipped_stats = pd.DataFrame({
        "status": ["Skipped", "Not Skipped"],
        "count": [skipped_songs, not_skipped_songs],
        "percent": [
            round(skipped_songs / total_songs * 100, 2) if total_songs > 0 else 0,
            round(not_skipped_songs / total_songs * 100, 2) if total_songs > 0 else 0
        ]
    })
    out["skipped_overview"] = skipped_stats
    
    # Brani saltati per artista
    skipped_by_artist = (
        df_copy[df_copy["skipped"]]
        .groupby("artist")
        .size()
        .reset_index(name="skipped count")
        .sort_values("skipped count", ascending=False)
        .head(50)
    )
    out["most_skipped_artists"] = skipped_by_artist
    
    # Brani saltati per traccia
    skipped_by_track = (
        df_copy[df_copy["skipped"]]
        .groupby("track")
        .size()
        .reset_index(name="skipped count")
        .sort_values("skipped count", ascending=False)
        .head(50)
    )
    out["most_skipped_tracks"] = skipped_by_track
    
    # Percentuale di skip per artista (top artisti)
    artist_skip_rate = (
        df_copy.groupby("artist")
        .agg({
            "skipped": "sum",
            "full_play": "sum"
        })
        .reset_index()
    )
    artist_skip_rate["total_plays"] = (
        df_copy.groupby("artist").size().reset_index(name="total")["total"]
    )
    artist_skip_rate["skip_rate"] = round(
        artist_skip_rate["skipped"] / artist_skip_rate["total_plays"] * 100, 2
    )
    artist_skip_rate = (
        artist_skip_rate[artist_skip_rate["total_plays"] >= 10]
        .sort_values("skip_rate", ascending=False)
        .head(30)
        [["artist", "skip_rate", "skipped", "total_plays"]]
    )
    artist_skip_rate.columns = ["artist", "skip rate %", "skipped count", "total plays"]
    out["artist_skip_rates"] = artist_skip_rate
    
    # Skip rate per mese
    monthly_skip_rate = (
        df_copy.groupby("year_month")
        .agg({
            "skipped": "sum",
            "full_play": "count"
        })
        .reset_index()
    )
    monthly_skip_rate["skip_rate"] = round(
        monthly_skip_rate["skipped"] / monthly_skip_rate["full_play"] * 100, 2
    )
    monthly_skip_rate = monthly_skip_rate.rename(columns={
        "year_month": "month",
        "skipped": "skipped count",
        "full_play": "total plays"
    })
    out["monthly_skip_rate"] = monthly_skip_rate
    
    return out


def get_username_statistics(df):
    """
    Analisi per username (utile se ci sono più utenti).
    """
    out = {}
    
    if "username" not in df.columns:
        return out
    
    # Conta utenti unici
    unique_users = df["username"].nunique()
    
    if unique_users <= 1:
        # Un solo utente, non serve analisi
        return out
    
    # Statistiche per utente
    user_stats = (
        df[df["full_play"]]
        .groupby("username")
        .agg({
            "full_play": "count",
            "hours_played": "sum",
            "track": "nunique",
            "artist": "nunique"
        })
        .rename(columns={
            "full_play": "play count",
            "track": "unique tracks",
            "artist": "unique artists"
        })
        .reset_index()
    )
    user_stats["hours played"] = user_stats["hours_played"].round(2)
    user_stats = user_stats.drop(columns=["hours_played"])
    user_stats = user_stats.sort_values("play count", ascending=False)
    out["user_statistics"] = user_stats
    
    return out


def get_mood_statistics(df):
    """
    Calcola statistiche sul mood delle canzoni ascoltate.
    Richiede che il DataFrame abbia una colonna 'valence'.
    """
    out = {}
    
    # Crea una copia per non modificare il DataFrame originale
    df_copy = df.copy()
    
    # Assicurati che il mood sia classificato
    if 'mood' not in df_copy.columns and 'valence' in df_copy.columns:
        if 'energy' in df_copy.columns:
            # Usa classify_mood con valence ed energy
            df_copy['mood'] = df_copy.apply(lambda row: classify_mood(row['valence'], row['energy']), axis=1)
        else:
            # Fallback: usa classify_mood solo con valence
            df_copy['mood'] = df_copy['valence'].apply(lambda v: classify_mood(v, None))

    if 'mood' not in df_copy.columns:
        return out

    
    # Filtra solo le canzoni completate
    df_full = df_copy[df_copy["full_play"]].copy()
    
    # Statistiche generali sul mood
    mood_counts = df_full['mood'].value_counts()
    total_plays = len(df_full)
    
    # Usa solo i mood v2
    mood_percentages = {}
    all_moods_v2 = MOOD_V2_WITH_UNKNOWN
    for mood in all_moods_v2:
        count = mood_counts.get(mood, 0)
        mood_percentages[mood] = round(count / total_plays * 100, 2) if total_plays > 0 else 0
    
    mood_stats_df = pd.DataFrame({
        'mood': list(mood_percentages.keys()),
        'percentuale': list(mood_percentages.values()),
        'conteggio': [mood_counts.get(mood, 0) for mood in mood_percentages.keys()]
    })
    out['mood_distribution'] = mood_stats_df
    
    # Mood per settimana
    df_full['year_week'] = df_full['ts'].dt.to_period('W').astype(str)
    mood_weekly = df_full.groupby(['year_week', 'mood']).size().reset_index(name='conteggio')
    mood_weekly_pivot = mood_weekly.pivot(index='year_week', columns='mood', values='conteggio').fillna(0)
    mood_weekly_pivot = add_missing_mood_columns(mood_weekly_pivot, MOOD_V2_CATEGORIES)
    mood_weekly_pivot['totale'] = mood_weekly_pivot[MOOD_V2_CATEGORIES].sum(axis=1)
    totals_week = mood_weekly_pivot['totale'].replace(0, np.nan)
    for mood in MOOD_V2_CATEGORIES:
        percent_series = (mood_weekly_pivot[mood] / totals_week).fillna(0) * 100
        mood_weekly_pivot[f'{mood}_percent'] = percent_series.round(2)
    mood_weekly_pivot = mood_weekly_pivot.reset_index()
    out['mood_per_week'] = mood_weekly_pivot
    
    # Mood per mese
    mood_monthly = df_full.groupby(['year_month', 'mood']).size().reset_index(name='conteggio')
    mood_monthly_pivot = mood_monthly.pivot(index='year_month', columns='mood', values='conteggio').fillna(0)
    mood_monthly_pivot = add_missing_mood_columns(mood_monthly_pivot, MOOD_V2_CATEGORIES)
    mood_monthly_pivot['totale'] = mood_monthly_pivot[MOOD_V2_CATEGORIES].sum(axis=1)
    totals_month = mood_monthly_pivot['totale'].replace(0, np.nan)
    for mood in MOOD_V2_CATEGORIES:
        percent_series = (mood_monthly_pivot[mood] / totals_month).fillna(0) * 100
        mood_monthly_pivot[f'{mood}_percent'] = percent_series.round(2)
    mood_monthly_pivot = mood_monthly_pivot.reset_index()
    out['mood_per_month'] = mood_monthly_pivot
    
    # Mood per giorno della settimana
    mood_by_day = df_full.groupby(['day_name', 'mood']).size().reset_index(name='conteggio')
    mood_by_day_pivot = mood_by_day.pivot(index='day_name', columns='mood', values='conteggio').fillna(0)
    mood_by_day_pivot = add_missing_mood_columns(mood_by_day_pivot, MOOD_V2_CATEGORIES)
    mood_by_day_pivot['totale'] = mood_by_day_pivot[MOOD_V2_CATEGORIES].sum(axis=1)
    totals_day = mood_by_day_pivot['totale'].replace(0, np.nan)
    for mood in MOOD_V2_CATEGORIES:
        percent_series = (mood_by_day_pivot[mood] / totals_day).fillna(0) * 100
        mood_by_day_pivot[f'{mood}_percent'] = percent_series.round(2)
    # Ordina per giorno della settimana
    weekdays_order = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    mood_by_day_pivot.index = pd.Categorical(mood_by_day_pivot.index, categories=weekdays_order, ordered=True)
    mood_by_day_pivot = mood_by_day_pivot.sort_index().reset_index()
    out['mood_per_day_of_week'] = mood_by_day_pivot

    # Mood per giorno (data specifica)
    mood_daily = df_full.groupby(['year_month_day', 'mood']).size().reset_index(name='conteggio')
    mood_daily_pivot = mood_daily.pivot(index='year_month_day', columns='mood', values='conteggio').fillna(0)
    mood_daily_pivot = add_missing_mood_columns(mood_daily_pivot, MOOD_V2_CATEGORIES)
    mood_daily_pivot['totale'] = mood_daily_pivot[MOOD_V2_CATEGORIES].sum(axis=1)
    totals_daily = mood_daily_pivot['totale'].replace(0, np.nan)
    for mood in MOOD_V2_CATEGORIES:
        percent_series = (mood_daily_pivot[mood] / totals_daily).fillna(0) * 100
        mood_daily_pivot[f'{mood}_percent'] = percent_series.round(2)
    mood_daily_pivot = mood_daily_pivot.reset_index().sort_values('year_month_day')
    out['mood_per_day'] = mood_daily_pivot

    return out


def get_df_dict(df, top_k=100, only_top_k=False):
    df_dict = {}

    df_dict.update(get_most_played_artists_tracks_albums_total(df, top_k))

    df_dict.update(
        get_most_played_artists_tracks_albums_total(
            df[df["reason_start"] == "clickrow"],
            top_k,
            "_reason_start_clickrow",
            column_name_muliplier_list=["track"],
        )
    )
    df_dict.update(get_top_songs_of_top_artists(df, top_k))
    if only_top_k:
        return df_dict

    df_dict.update(get_most_played_artist_track_album_monthly(df))
    df_dict.update(get_avg_track_length_monthly(df))
    df_dict.update(get_avg_play_count_per_song_yearly(df))
    df_dict.update(get_play_count_distribution(df))

    df_dict.update(get_yeary_track_artist_play_count(df))

    df_dict.update(get_hours_played_per_hour_of_the_day(df))
    df_dict.update(get_avg_hours_played_per_year_month_weekday(df))

    df_dict.update(get_plays_per_county_toal(df))
    df_dict.update(get_cumulative_percent_play_count_track_artists(df))
    
    # Aggiungi analisi del mood se disponibile
    if 'valence' in df.columns:
        df_dict.update(get_mood_statistics(df))
    
    # Aggiungi analisi per user agent (dispositivo/browser)
    if 'user_agent_decrypted' in df.columns:
        df_dict.update(get_user_agent_statistics(df))
    
    # Aggiungi analisi dettagliate per skipped
    if 'skipped' in df.columns:
        df_dict.update(get_skipped_statistics(df))
    
    # Aggiungi analisi per username (se più utenti)
    if 'username' in df.columns:
        df_dict.update(get_username_statistics(df))
    
    return df_dict

