const ISO_COUNTRY_CODES_LEGACY = [
  'AD','AE','AF','AG','AL','AM','AO','AR','AT','AU','AZ','BA','BB','BD','BE','BF','BG','BH','BI','BJ','BN','BO','BR','BS','BT','BW','BY','BZ','CA','CD','CF','CG','CH','CI','CL','CM','CN','CO','CR','CU','CV','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE','EG','ER','ES','ET','FI','FJ','FM','FR','GA','GB','GD','GE','GH','GM','GN','GQ','GR','GT','GW','GY','HN','HR','HT','HU','ID','IE','IL','IN','IQ','IR','IS','IT','JM','JO','JP','KE','KG','KH','KI','KM','KN','KP','KR','KW','KZ','LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MG','MH','MK','ML','MM','MN','MR','MT','MU','MV','MW','MX','MY','MZ','NA','NE','NG','NI','NL','NO','NP','NR','NZ','OM','PA','PE','PG','PH','PK','PL','PS','PT','PW','PY','QA','RO','RS','RU','RW','SA','SB','SC','SD','SE','SG','SI','SK','SL','SM','SN','SO','SR','SS','ST','SV','SY','SZ','TD','TG','TH','TJ','TL','TM','TN','TO','TR','TT','TV','TW','TZ','UA','UG','US','UY','UZ','VA','VC','VE','VN','VU','WS','YE','ZA','ZM','ZW',
] as const

const COUNTRY_NAMES: Record<string, string> = {
  AD:'Andorra',AE:'United Arab Emirates',AF:'Afghanistan',AG:'Antigua and Barbuda',AL:'Albania',AM:'Armenia',AO:'Angola',AR:'Argentina',AT:'Austria',AU:'Australia',AZ:'Azerbaijan',
  BA:'Bosnia and Herzegovina',BB:'Barbados',BD:'Bangladesh',BE:'Belgium',BF:'Burkina Faso',BG:'Bulgaria',BH:'Bahrain',BI:'Burundi',BJ:'Benin',BN:'Brunei',BO:'Bolivia',BR:'Brazil',BS:'Bahamas',BT:'Bhutan',BW:'Botswana',BY:'Belarus',BZ:'Belize',
  CA:'Canada',CD:'DR Congo',CF:'Central African Republic',CG:'Congo',CH:'Switzerland',CI:'Ivory Coast',CL:'Chile',CM:'Cameroon',CN:'China',CO:'Colombia',CR:'Costa Rica',CU:'Cuba',CV:'Cape Verde',CY:'Cyprus',CZ:'Czechia',
  DE:'Germany',DJ:'Djibouti',DK:'Denmark',DM:'Dominica',DO:'Dominican Republic',DZ:'Algeria',EC:'Ecuador',EE:'Estonia',EG:'Egypt',ER:'Eritrea',ES:'Spain',ET:'Ethiopia',
  FI:'Finland',FJ:'Fiji',FM:'Micronesia',FR:'France',
  GA:'Gabon',GB:'United Kingdom',GD:'Grenada',GE:'Georgia',GH:'Ghana',GM:'Gambia',GN:'Guinea',GQ:'Equatorial Guinea',GR:'Greece',GT:'Guatemala',GW:'Guinea-Bissau',GY:'Guyana',
  HN:'Honduras',HR:'Croatia',HT:'Haiti',HU:'Hungary',
  ID:'Indonesia',IE:'Ireland',IL:'Israel',IN:'India',IQ:'Iraq',IR:'Iran',IS:'Iceland',IT:'Italy',
  JM:'Jamaica',JO:'Jordan',JP:'Japan',
  KE:'Kenya',KG:'Kyrgyzstan',KH:'Cambodia',KI:'Kiribati',KM:'Comoros',KN:'Saint Kitts and Nevis',KP:'North Korea',KR:'South Korea',KW:'Kuwait',KZ:'Kazakhstan',
  LA:'Laos',LB:'Lebanon',LC:'Saint Lucia',LI:'Liechtenstein',LK:'Sri Lanka',LR:'Liberia',LS:'Lesotho',LT:'Lithuania',LU:'Luxembourg',LV:'Latvia',LY:'Libya',
  MA:'Morocco',MC:'Monaco',MD:'Moldova',ME:'Montenegro',MG:'Madagascar',MH:'Marshall Islands',MK:'North Macedonia',ML:'Mali',MM:'Myanmar',MN:'Mongolia',MR:'Mauritania',MT:'Malta',MU:'Mauritius',MV:'Maldives',MW:'Malawi',MX:'Mexico',MY:'Malaysia',MZ:'Mozambique',
  NA:'Namibia',NE:'Niger',NG:'Nigeria',NI:'Nicaragua',NL:'Netherlands',NO:'Norway',NP:'Nepal',NR:'Nauru',NZ:'New Zealand',
  OM:'Oman',
  PA:'Panama',PE:'Peru',PG:'Papua New Guinea',PH:'Philippines',PK:'Pakistan',PL:'Poland',PS:'Palestine',PT:'Portugal',PW:'Palau',PY:'Paraguay',
  QA:'Qatar',RO:'Romania',RS:'Serbia',RU:'Russia',RW:'Rwanda',
  SA:'Saudi Arabia',SB:'Solomon Islands',SC:'Seychelles',SD:'Sudan',SE:'Sweden',SG:'Singapore',SI:'Slovenia',SK:'Slovakia',SL:'Sierra Leone',SM:'San Marino',SN:'Senegal',SO:'Somalia',SR:'Suriname',SS:'South Sudan',ST:'Sao Tome and Principe',SV:'El Salvador',SY:'Syria',SZ:'Eswatini',
  TD:'Chad',TG:'Togo',TH:'Thailand',TJ:'Tajikistan',TL:'Timor-Leste',TM:'Turkmenistan',TN:'Tunisia',TO:'Tonga',TR:'Turkey',TT:'Trinidad and Tobago',TV:'Tuvalu',TW:'Taiwan',TZ:'Tanzania',
  UA:'Ukraine',UG:'Uganda',US:'United States',UY:'Uruguay',UZ:'Uzbekistan',
  VA:'Vatican City',VC:'Saint Vincent and the Grenadines',VE:'Venezuela',VN:'Vietnam',VU:'Vanuatu',
  WS:'Samoa',
  YE:'Yemen',
  ZA:'South Africa',ZM:'Zambia',ZW:'Zimbabwe',
}

export const ISO_COUNTRY_CODES = Object.keys(COUNTRY_NAMES).sort() as readonly string[]
export const WORLD_COUNTRIES = ISO_COUNTRY_CODES.map(code => ({ code, name: COUNTRY_NAMES[code] ?? code }))

export const MAJOR_CITIES: Record<string, string[]> = {
  AE: ['Abu Dhabi', 'Dubai', 'Sharjah'], AR: ['Buenos Aires', 'Cordoba', 'Rosario'], AT: ['Vienna', 'Graz'], AU: ['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide'],
  BD: ['Dhaka', 'Chittagong'], BE: ['Brussels', 'Antwerp'], BR: ['Sao Paulo', 'Rio de Janeiro', 'Brasilia', 'Belo Horizonte'], CA: ['Toronto', 'Vancouver', 'Montreal', 'Calgary', 'Ottawa'],
  CH: ['Zurich', 'Geneva', 'Bern'], CL: ['Santiago', 'Valparaiso'], CN: ['Beijing', 'Shanghai', 'Guangzhou', 'Shenzhen', 'Chengdu'], CO: ['Bogota', 'Medellin', 'Cali'],
  CZ: ['Prague', 'Brno'], DE: ['Berlin', 'Frankfurt', 'Munich', 'Hamburg', 'Cologne'], DK: ['Copenhagen', 'Aarhus'], EG: ['Cairo', 'Alexandria'], ES: ['Madrid', 'Barcelona', 'Valencia', 'Seville'],
  FI: ['Helsinki', 'Tampere'], FR: ['Paris', 'Marseille', 'Lyon', 'Toulouse', 'Nice'], GB: ['London', 'Manchester', 'Birmingham', 'Edinburgh', 'Glasgow'], GH: ['Accra', 'Kumasi'],
  GR: ['Athens', 'Thessaloniki'], HK: ['Hong Kong'], HU: ['Budapest', 'Debrecen'], ID: ['Jakarta', 'Surabaya', 'Bandung', 'Medan'], IE: ['Dublin', 'Cork'], IL: ['Tel Aviv', 'Jerusalem', 'Haifa'],
  IN: ['Mumbai', 'Delhi', 'Bengaluru', 'Hyderabad', 'Chennai', 'Kolkata', 'Pune', 'Ahmedabad'], IT: ['Rome', 'Milan', 'Naples', 'Turin', 'Florence'], JP: ['Tokyo', 'Osaka', 'Yokohama', 'Nagoya', 'Fukuoka'],
  KE: ['Nairobi', 'Mombasa'], KR: ['Seoul', 'Busan', 'Incheon'], LK: ['Colombo', 'Kandy'], MA: ['Casablanca', 'Rabat', 'Marrakesh'], MX: ['Mexico City', 'Guadalajara', 'Monterrey', 'Tijuana'],
  MY: ['Kuala Lumpur', 'George Town', 'Johor Bahru'], NG: ['Lagos', 'Abuja', 'Kano'], NL: ['Amsterdam', 'Rotterdam', 'The Hague', 'Utrecht'], NO: ['Oslo', 'Bergen'], NZ: ['Auckland', 'Wellington', 'Christchurch'],
  PE: ['Lima', 'Arequipa'], PH: ['Manila', 'Cebu City', 'Davao City'], PK: ['Karachi', 'Lahore', 'Islamabad'], PL: ['Warsaw', 'Krakow', 'Wroclaw', 'Gdansk'], PT: ['Lisbon', 'Porto'],
  QA: ['Doha'], RO: ['Bucharest', 'Cluj-Napoca'], SA: ['Riyadh', 'Jeddah', 'Dammam'], SE: ['Stockholm', 'Gothenburg', 'Malmo'], SG: ['Singapore'], TH: ['Bangkok', 'Chiang Mai', 'Phuket'],
  TR: ['Istanbul', 'Ankara', 'Izmir'], TW: ['Taipei', 'Kaohsiung'], UA: ['Kyiv', 'Lviv', 'Odesa'], US: ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia', 'San Antonio', 'San Diego', 'Dallas', 'Miami', 'Seattle', 'Atlanta', 'Boston', 'Denver', 'Las Vegas'],
  VE: ['Caracas', 'Maracaibo'], VN: ['Ho Chi Minh City', 'Hanoi', 'Da Nang'], ZA: ['Johannesburg', 'Cape Town', 'Durban', 'Pretoria'],
}



